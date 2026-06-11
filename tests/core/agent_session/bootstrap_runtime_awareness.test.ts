import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { getSessionBootstrap } from '../../../src/core/agent_session/bootstrap.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import { recordConflict } from '../../../src/core/coordination/conflicts.js';

/**
 * Phase 3B — runtime awareness section of session bootstrap (integration).
 *
 * What breaks if removed:
 *   - bootstrap could stop carrying the preflight section MCP/CLI agents rely
 *     on before editing/committing;
 *   - the awareness section could disagree with the real claim-aware git
 *     summary (counts, staged-unclaimed detection) on a REAL working tree;
 *   - lifecycle wiring (heartbeat-on-bootstrap, read_only, terminated) could
 *     silently regress.
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

function write(repo: string, rel: string, content = 'x\n'): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

const STUB_CODEGRAPH = async () => ({ available: false, initialized: false, version: null });
const baseOpts = { codegraphStatus: STUB_CODEGRAPH } as const;

function registerBuild(repo: string, agentId: string, now?: string): void {
  registerAgent(
    repo,
    { agent_name: agentId, agent_type: 'claude', metadata: { operating_mode: 'build', task: 'phase 3b' } },
    { agentId, ...(now ? { now } : {}) },
  );
}

describe('session bootstrap — runtime_awareness (Phase 3B)', () => {
  test('active build agent, clean repo: preflight ok, server null in core', async () => {
    const repo = makeRepo('vibecode-ra-clean-');
    registerBuild(repo, 'agent-me');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    expect(result.ok).toBe(true);
    const ra = result.runtime_awareness;
    expect(ra.agent.registered).toBe(true);
    expect(ra.agent.agent_id).toBe('agent-me');
    expect(ra.agent.status).toBe('active');
    expect(ra.agent.operating_mode).toBe('build');
    // Bootstrap heartbeats the supplied agent, so the heartbeat is fresh.
    expect(ra.agent.needs_heartbeat).toBe(false);
    expect(ra.server).toBeNull();
    expect(ra.workspace.git_available).toBe(true);
    expect(ra.workspace.dirty).toBe(false);
    expect(ra.commit_guard.can_edit).toBe(true);
    expect(ra.commit_guard.finalize_ready).toBe(true);
    expect(ra.commit_guard.commit_guard_ready).toBe(false);
    expect(ra.blockers).toEqual([]);
  });

  test('claimed dirty files: commit guard ready with exact next commands', async () => {
    const repo = makeRepo('vibecode-ra-claimed-');
    registerBuild(repo, 'agent-me');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.workspace.changed_counts.claimed_by_agent).toBe(1);
    expect(ra.commit_guard.finalize_ready).toBe(true);
    expect(ra.commit_guard.commit_guard_ready).toBe(true);
    expect(ra.commit_guard.isolated_commit_possible).toBe(false);
    expect(
      ra.recommended_cli_commands.some((c) => c === 'vibecode commit guard --agent agent-me --dry-run --json'),
    ).toBe(true);
  });

  test('claimed + unstaged unclaimed: finalize blocked, isolated commit likely', async () => {
    const repo = makeRepo('vibecode-ra-isolated-');
    registerBuild(repo, 'agent-me');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/unrelated-wip.ts');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.workspace.shared_tree_dirty).toBe(true);
    expect(ra.commit_guard.finalize_ready).toBe(false);
    expect(ra.commit_guard.isolated_commit_possible).toBe(true);
    expect(ra.warnings.some((w) => w.code === 'ISOLATED_COMMIT_LIKELY')).toBe(true);
  });

  test('claimed + STAGED unclaimed: commit guard likely blocked', async () => {
    const repo = makeRepo('vibecode-ra-staged-');
    registerBuild(repo, 'agent-me');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/unrelated-staged.ts');
    git(['add', '--', 'src/unrelated-staged.ts'], repo);

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.commit_guard.staged_unclaimed_blockers).toBe(1);
    expect(ra.commit_guard.isolated_commit_possible).toBe(false);
    expect(ra.warnings.some((w) => w.code === 'STAGED_UNCLAIMED_FILES_PRESENT')).toBe(true);
  });

  test('claimed + STAGED other-agent claimed file: commit guard not ready (GIT_INDEX_NOT_CLEAN mirror)', async () => {
    const repo = makeRepo('vibecode-ra-staged-other-');
    registerBuild(repo, 'agent-me');
    registerBuild(repo, 'agent-other');
    addFileClaim(repo, { agent_id: 'agent-me', path: 'src/mine.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: 'agent-other', path: 'src/theirs.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/theirs.ts');
    git(['add', '--', 'src/theirs.ts'], repo);

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.workspace.changed_counts.staged_claimed_by_other_agent).toBe(1);
    // Finalize only warns on the other agent's claimed file, but the guard
    // blocks on any staged file outside the committable set.
    expect(ra.commit_guard.finalize_ready).toBe(true);
    expect(ra.commit_guard.commit_guard_ready).toBe(false);
    expect(ra.commit_guard.isolated_commit_possible).toBe(false);
    expect(ra.warnings.some((w) => w.code === 'STAGED_OTHER_AGENT_FILES_PRESENT')).toBe(true);
    expect(ra.recovery.resume_state).not.toBe('ready_to_commit');
  });

  test('read_only agent: no edit/commit readiness or commands', async () => {
    const repo = makeRepo('vibecode-ra-readonly-');
    registerAgent(
      repo,
      { agent_name: 'RO', agent_type: 'claude', metadata: { operating_mode: 'read_only', task: 'review' } },
      { agentId: 'agent-ro' },
    );

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-ro', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.agent.operating_mode).toBe('read_only');
    expect(ra.commit_guard.can_edit).toBe(false);
    expect(ra.commit_guard.commit_guard_ready).toBe(false);
    expect(ra.recommended_cli_commands.join(' ')).not.toContain('commit guard');
  });

  test('terminated agent: bootstrap blocks and the awareness carries the blocker', async () => {
    const repo = makeRepo('vibecode-ra-term-');
    registerBuild(repo, 'agent-dead');
    markAgentTerminated(repo, 'agent-dead');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-dead', ...baseOpts });
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => b.code === 'AGENT_TERMINATED')).toBe(true);
    const ra = result.runtime_awareness;
    expect(ra.agent.status).toBe('terminated');
    expect(ra.blockers.some((b) => b.code === 'AGENT_TERMINATED')).toBe(true);
    expect(ra.commit_guard.can_edit).toBe(false);
  });

  test('clean releasable intent: counted and intent-release dry-run recommended', async () => {
    const repo = makeRepo('vibecode-ra-release-');
    registerBuild(repo, 'agent-me');
    addBulkClaims({ repoRoot: repo, agent_id: 'agent-me', intent: 'done work', paths: ['src/done.ts'] });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.coordination.active_intents_count).toBe(1);
    expect(ra.coordination.releasable_intents_count).toBe(1);
    expect(
      ra.recommended_cli_commands.some((c) => c.includes('intent-release') && c.includes('--dry-run')),
    ).toBe(true);
  });

  test('dirty claimed intent is not releasable', async () => {
    const repo = makeRepo('vibecode-ra-norelease-');
    registerBuild(repo, 'agent-me');
    addBulkClaims({ repoRoot: repo, agent_id: 'agent-me', intent: 'wip', paths: ['src/wip.ts'] });
    write(repo, 'src/wip.ts');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.coordination.active_intents_count).toBe(1);
    expect(ra.coordination.releasable_intents_count).toBe(0);
    expect(ra.recommended_cli_commands.join(' ')).not.toContain('intent-release');
  });

  test('still-blocking conflict involving the agent is counted with safe guidance', async () => {
    const repo = makeRepo('vibecode-ra-conflict-');
    registerBuild(repo, 'agent-me');
    registerBuild(repo, 'agent-other');
    addFileClaim(
      repo,
      { agent_id: 'agent-other', path: 'src/contested.ts', mode: 'exclusive' },
      { claimId: 'claim-blk' },
    );
    recordConflict(repo, {
      conflict_type: 'claim_denied',
      detected_at: new Date().toISOString(),
      involved_claims: ['claim-blk'],
      involved_agents: ['agent-me', 'agent-other'],
      involved_files: ['src/contested.ts'],
      severity: 'medium',
      description: 'Claim denied for src/contested.ts.',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.coordination.conflicts_involving_agent_count).toBe(1);
    expect(ra.coordination.still_blocking_conflicts_involving_agent_count).toBe(1);
    expect(
      ra.recommended_cli_commands.some((c) => c.includes('--profile conflict_resolution')),
    ).toBe(true);
  });

  test('stale coordination state is reflected in the awareness section', async () => {
    const repo = makeRepo('vibecode-ra-stalecoord-');
    registerBuild(repo, 'agent-old', '2020-01-01T00:00:00.000Z');
    registerBuild(repo, 'agent-me');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-me', ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.coordination.stale_coordination_present).toBe(true);
    expect(ra.recommended_cli_commands.some((c) => c.includes('claims reap --dry-run'))).toBe(true);
  });

  test('unregistered orientation: awareness reports NOT_REGISTERED and register guidance', async () => {
    const repo = makeRepo('vibecode-ra-unreg-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    const ra = result.runtime_awareness;
    expect(ra.agent.registered).toBe(false);
    expect(ra.warnings.some((w) => w.code === 'NOT_REGISTERED')).toBe(true);
    expect(ra.recommended_cli_commands.some((c) => c.includes('--register'))).toBe(true);
  });
});
