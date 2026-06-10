import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { getSessionBootstrap } from '../../../src/core/agent_session/bootstrap.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addBulkClaims, listClaimIntents } from '../../../src/core/coordination/bulk_claims.js';
import { releaseFileClaim, listFileClaims } from '../../../src/core/coordination/claims.js';
import { releaseClaimIntent } from '../../../src/core/coordination/intent_lifecycle.js';
import { CoordinationError } from '../../../src/core/coordination/errors.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';

/**
 * Phase 2C: session_bootstrap stale coordination summary.
 *
 * What breaks if removed:
 *   - bootstrap could stop explaining stale agents/claims/intents (back to
 *     unexplained noise);
 *   - the summary could silently become unbounded, mutate state, or start
 *     recommending automatic / cross-agent cleanup.
 */

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repo);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  return repo;
}

const STUB_CODEGRAPH = async () => ({ available: false, initialized: false, version: null });
const baseOpts = { codegraphStatus: STUB_CODEGRAPH } as const;

const T0 = '2026-06-10T00:00:00.000Z';
const LATER = new Date(Date.parse(T0) + HEARTBEAT_TTL_MS + 60_000).toISOString();

function registerBuild(repo: string, agentId: string, now: string): void {
  registerAgent(
    repo,
    { agent_name: agentId, agent_type: 'codex', metadata: { operating_mode: 'build', task: 'work' } },
    { agentId, now },
  );
}

describe('session_bootstrap — stale_coordination summary (Phase 2C)', () => {
  test('clean repo stays compact: no stale state, no housekeeping noise', async () => {
    const repo = makeRepo('vibecode-stale-clean-');
    registerBuild(repo, 'agent-me', T0);

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', now: T0, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.stale_coordination.has_stale_state).toBe(false);
    expect(result.stale_coordination.stale_agents_count).toBe(0);
    expect(result.stale_coordination.recommended_cli_commands).toEqual([]);
    expect(result.recommended_tool_profiles.map((p) => p.profile_id)).not.toContain('coordination_housekeeping');
  });

  test('stale agent with claims and an active intent is summarized with explicit housekeeping guidance', async () => {
    const repo = makeRepo('vibecode-stale-summary-');
    // Old agent worked at T0 and went stale.
    registerBuild(repo, 'agent-old', T0);
    addBulkClaims({ repoRoot: repo, agent_id: 'agent-old', intent: 'old work', paths: ['src/old.ts'], now: T0 });
    // Fresh agent bootstraps later.
    registerBuild(repo, 'agent-me', LATER);

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', now: LATER, ...baseOpts });
    expect(result.ok).toBe(true);

    const stale = result.stale_coordination;
    expect(stale.has_stale_state).toBe(true);
    expect(stale.stale_agents_count).toBe(1);
    expect(stale.stale_active_claims_count).toBe(1);
    expect(stale.active_intents_owned_by_stale_agents_count).toBe(1);
    expect(stale.samples.stale_agents[0].agent_id).toBe('agent-old');
    expect(stale.samples.stale_claims[0].path).toBe('src/old.ts');
    expect(stale.samples.stale_intents[0]).toMatchObject({ agent_id: 'agent-old', owner_status: 'stale' });

    // Explicit, bounded recommendations: list/reap/heartbeat — never an
    // automatic cleanup and never another agent's intent release.
    expect(stale.recommended_cli_commands).toContain('vibecode claims list --json');
    expect(stale.recommended_cli_commands).toContain('vibecode claims reap --dry-run --json');
    expect(stale.recommended_cli_commands).toContain('vibecode agents heartbeat --agent agent-me --json');
    expect(stale.recommended_cli_commands.every((c) => !c.includes('intent-release'))).toBe(true);

    // Bootstrap surfaces a bounded warning and the housekeeping profile.
    expect(result.warnings.some((w) => w.code === 'STALE_COORDINATION_STATE')).toBe(true);
    expect(result.recommended_tool_profiles.map((p) => p.profile_id)).toContain('coordination_housekeeping');
    // Recommended CLI commands include the stale-state housekeeping commands.
    expect(result.recommended_cli_commands).toContain('vibecode claims reap --dry-run --json');
  });

  test('terminated owner of an active intent is distinguished from stale', async () => {
    const repo = makeRepo('vibecode-stale-term-');
    registerBuild(repo, 'agent-old', T0);
    addBulkClaims({ repoRoot: repo, agent_id: 'agent-old', intent: 'old work', paths: ['src/old.ts'], now: T0 });
    markAgentTerminated(repo, 'agent-old', { now: T0 });
    registerBuild(repo, 'agent-me', T0);

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', now: T0, ...baseOpts });
    const stale = result.stale_coordination;
    expect(stale.active_intents_owned_by_terminated_agents_count).toBe(1);
    expect(stale.active_intents_owned_by_stale_agents_count).toBe(0);
    expect(stale.samples.stale_intents[0].owner_status).toBe('terminated');
  });

  test('own active intent with zero active claims is surfaced safely', async () => {
    const repo = makeRepo('vibecode-stale-noclaims-');
    registerBuild(repo, 'agent-me', T0);
    addBulkClaims({ repoRoot: repo, agent_id: 'agent-me', intent: 'my work', paths: ['src/a.ts'], now: T0 });
    // Release the claim directly (not by intent): intent stays active, claimless.
    releaseFileClaim(repo, listFileClaims(repo, { now: T0 })[0].claim_id);

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', now: T0, ...baseOpts });
    const stale = result.stale_coordination;
    expect(stale.has_stale_state).toBe(true);
    expect(stale.active_intents_with_no_active_claims_count).toBe(1);
    expect(stale.samples.intents_with_no_active_claims[0].agent_id).toBe('agent-me');
    expect(result.warnings.some((w) => w.code === 'STALE_COORDINATION_STATE')).toBe(true);
  });

  test('summary is read-only: another agent’s stale intent is never released by bootstrap', async () => {
    const repo = makeRepo('vibecode-stale-norelease-');
    registerBuild(repo, 'agent-old', T0);
    const bulk = addBulkClaims({ repoRoot: repo, agent_id: 'agent-old', intent: 'old work', paths: ['src/old.ts'], now: T0 });
    registerBuild(repo, 'agent-me', LATER);

    await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', now: LATER, ...baseOpts });

    // The old agent's intent and claims survive bootstrap untouched.
    const intents = listClaimIntents(repo, { now: LATER });
    expect(intents.find((i) => i.intent_id === bulk.intent_id)?.status).toBe('active');
    expect(listFileClaims(repo, { now: LATER, includeReleased: true }).every((c) => c.released_at === null)).toBe(true);

    // And agent-me cannot release agent-old's intent (same-agent only).
    try {
      releaseClaimIntent({ repoRoot: repo, agent_id: 'agent-me', intent_id: bulk.intent_id!, now: LATER });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CoordinationError).code).toBe('INTENT_FORBIDDEN');
    }
  });

  test('long-session heartbeat via bootstrap revives the agent and leaves claims/intents unchanged', async () => {
    const repo = makeRepo('vibecode-stale-longsession-');
    registerBuild(repo, 'agent-me', T0);
    const bulk = addBulkClaims({ repoRoot: repo, agent_id: 'agent-me', intent: 'my work', paths: ['src/a.ts'], now: T0 });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', now: LATER, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.current_agent?.status).toBe('active');
    expect(result.generated_state_written).toBe(true);

    // Claims and intents are untouched by the heartbeat.
    const claims = listFileClaims(repo, { now: LATER });
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe('active');
    expect(listClaimIntents(repo, { now: LATER }).find((i) => i.intent_id === bulk.intent_id)?.status).toBe('active');

    // The agent's own freshly-heartbeated state is not flagged stale.
    expect(result.stale_coordination.stale_agents_count).toBe(0);
  });
});
