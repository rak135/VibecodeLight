import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import {
  getSessionBootstrap,
  AGENT_OPERATING_PROTOCOL,
  POSSIBLY_STALE_ACTIVE_CLAIM_MIN_AGE_MS,
} from '../../../src/core/agent_session/bootstrap.js';
import { registerAgent, markAgentTerminated, listAgents } from '../../../src/core/coordination/agents.js';
import { addFileClaim, releaseFileClaim } from '../../../src/core/coordination/claims.js';
import { recordConflict } from '../../../src/core/coordination/conflicts.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import { releaseClaimIntent } from '../../../src/core/coordination/intent_lifecycle.js';

/**
 * Phase 1A — session bootstrap aggregator. Exercised against REAL git working
 * trees + REAL coordination state. CodeGraph status is stubbed so tests never
 * spawn the upstream binary.
 */
function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string, opts: { gitignoreVibecode?: boolean } = {}): string {
  const ignore = opts.gitignoreVibecode !== false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo with spaces');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  if (ignore) {
    fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
    git(['add', '.gitignore'], repo);
  }
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

const T0 = '2026-01-01T00:00:00.000Z';
const T_LATER = '2026-01-01T01:00:00.000Z'; // > heartbeat TTL after T0

describe('getSessionBootstrap — git + orientation', () => {
  test('clean repo: dirty false, protocol + recommendations present', async () => {
    const repo = makeRepo('vibecode-bs-clean-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.git.available).toBe(true);
    expect(result.git.dirty).toBe(false);
    expect(result.git.changed_counts.total).toBe(0);
    expect(result.agent_protocol).toEqual([...AGENT_OPERATING_PROTOCOL]);
    expect(result.recommended_next_tools.length).toBeGreaterThan(0);
    expect(result.recommended_cli_commands.length).toBeGreaterThan(0);
    expect(result.recommended_next_tools).toContain('vibecode_git_changes');
  });

  test('dirty repo: changed counts and sample paths are populated', async () => {
    const repo = makeRepo('vibecode-bs-dirty-');
    write(repo, 'src/a.ts');
    write(repo, 'src/b.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.git.dirty).toBe(true);
    expect(result.git.changed_counts.total).toBe(2);
    expect(result.git.changed_counts.untracked).toBe(2);
    expect(result.git.sample_changed_files.length).toBeGreaterThan(0);
  });

  test('generated_or_ignored is surfaced in changed_counts', async () => {
    const repo = makeRepo('vibecode-bs-generated-', { gitignoreVibecode: false });
    // Write a .vibecode file (generated runtime path) and a source file.
    write(repo, path.join('.vibecode', 'coordination', 'state.json'), '{}\n');
    write(repo, 'src/a.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    // generated_or_ignored is present and counts .vibecode/ paths.
    expect(result.git.changed_counts.generated_or_ignored).toBeGreaterThanOrEqual(1);
    // The source file is counted separately as untracked.
    expect(result.git.changed_counts.untracked).toBeGreaterThanOrEqual(1);
    // Total is the total number of changed files.
    expect(result.git.changed_counts.total).toBeGreaterThanOrEqual(2);
  });

  test('defensive cap: rejects max_items above hard max', async () => {
    const repo = makeRepo('vibecode-bs-cap-reject-');
    await expect(
      getSessionBootstrap({ repoRoot: repo, max_items: 101, ...baseOpts }),
    ).rejects.toThrow(/exceeds maximum/);
  });

  test('defensive cap: accepts max_items at hard max (100)', async () => {
    const repo = makeRepo('vibecode-bs-cap-boundary-');
    const result = await getSessionBootstrap({ repoRoot: repo, max_items: 100, ...baseOpts });
    expect(result.ok).toBe(true);
  });

  test('bounded sections: agents/claims/conflicts/evidence/scan/codegraph present', async () => {
    const repo = makeRepo('vibecode-bs-sections-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.agents).toMatchObject({ total: 0, active: 0, stale: 0, terminated: 0 });
    expect(result.claims.counts).toMatchObject({ own: 0, other_active: 0, stale: 0 });
    expect(result.conflicts.unresolved_count).toBe(0);
    expect(result.evidence).toHaveProperty('recent_count');
    expect(result.codegraph).toMatchObject({ available: false, initialized: false });
    // Phase 1A: scan reports availability ONLY — no scan_summary sections.
    expect(result.scan).toHaveProperty('current_run_scan_available');
    expect(result.scan).not.toHaveProperty('sections');
    expect(result.scan).not.toHaveProperty('summary');
  });

  test('bounded project-instruction excerpt is included from AGENTS.md', async () => {
    const repo = makeRepo('vibecode-bs-instr-');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# AGENTS\n\nClaim before editing.\n', 'utf8');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.project_instructions.available).toBe(true);
    expect(result.project_instructions.sources).toContain('AGENTS.md');
    expect(typeof result.project_instructions.excerpt).toBe('string');
    expect(result.project_instructions.excerpt).toContain('AGENTS');
  });
});

describe('getSessionBootstrap — agent identity', () => {
  test('register=true creates an agent with operating mode + task and writes generated state', async () => {
    const repo = makeRepo('vibecode-bs-register-');
    const result = await getSessionBootstrap({
      repoRoot: repo,
      register: true,
      agent_mode: 'build',
      agent_name: 'Builder 1',
      agent_type: 'claude',
      task: 'implement phase 1a',
      ...baseOpts,
    });
    expect(result.ok).toBe(true);
    expect(result.generated_state_written).toBe(true);
    expect(result.current_agent).not.toBeNull();
    expect(result.current_agent?.operating_mode).toBe('build');
    expect(result.current_agent?.task).toBe('implement phase 1a');

    const agents = listAgents(repo);
    expect(agents).toHaveLength(1);
    expect(agents[0].metadata.operating_mode).toBe('build');
    expect(agents[0].metadata.task).toBe('implement phase 1a');
  });

  test('register=true requires a valid agent_mode', async () => {
    const repo = makeRepo('vibecode-bs-badmode-');
    const result = await getSessionBootstrap({
      repoRoot: repo,
      register: true,
      agent_mode: 'observer',
      task: 'x',
      ...baseOpts,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('INVALID_AGENT_MODE');
    expect(listAgents(repo)).toHaveLength(0);
  });

  test('register=true requires a task/intent', async () => {
    const repo = makeRepo('vibecode-bs-notask-');
    const result = await getSessionBootstrap({
      repoRoot: repo,
      register: true,
      agent_mode: 'read_only',
      ...baseOpts,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('AGENT_TASK_REQUIRED');
  });

  test('active agent_id heartbeats / refreshes', async () => {
    const repo = makeRepo('vibecode-bs-heartbeat-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, now: T0, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.generated_state_written).toBe(true);
    expect(result.current_agent?.agent_id).toBe(agent.agent_id);
    expect(result.current_agent?.status).toBe('active');
  });

  test('stale agent_id is revived by the bootstrap heartbeat', async () => {
    const repo = makeRepo('vibecode-bs-revive-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, now: T_LATER, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.generated_state_written).toBe(true);
    expect(result.current_agent?.status).toBe('active');
  });

  test('terminated agent_id returns a structured blocker (and writes nothing)', async () => {
    const repo = makeRepo('vibecode-bs-term-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    markAgentTerminated(repo, agent.agent_id);
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, ...baseOpts });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('AGENT_TERMINATED');
    expect(result.generated_state_written).toBe(false);
  });

  test('unknown agent_id returns a structured AGENT_NOT_FOUND blocker', async () => {
    const repo = makeRepo('vibecode-bs-unknown-');
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-nope', ...baseOpts });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('AGENT_NOT_FOUND');
  });

  test('missing agent_id with register=false reports a registration warning but still orients', async () => {
    const repo = makeRepo('vibecode-bs-noreg-');
    write(repo, 'src/a.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, register: false, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.current_agent).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain('NOT_REGISTERED');
    // Orientation is still returned.
    expect(result.git.dirty).toBe(true);
    expect(result.agent_protocol.length).toBeGreaterThan(0);
  });
});

describe('getSessionBootstrap — coordination summaries', () => {
  test('own / other / stale claims are split and conflicts are summarized', async () => {
    const repo = makeRepo('vibecode-bs-claims-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/theirs.ts', mode: 'exclusive' });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, ...baseOpts });
    expect(result.current_agent?.agent_id).toBe(a.agent_id);
    expect(result.claims.counts.own).toBe(1);
    expect(result.claims.counts.other_active).toBe(1);
    expect(result.claims.own[0]?.path).toBe('src/mine.ts');
    expect(result.agents.total).toBe(2);
    expect(result.agents.active).toBe(2);
  });

  test('claim lists are capped by max_items', async () => {
    const repo = makeRepo('vibecode-bs-cap-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    for (let i = 0; i < 5; i += 1) {
      addFileClaim(repo, { agent_id: a.agent_id, path: `src/f${i}.ts`, mode: 'shared' });
    }
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, max_items: 2, ...baseOpts });
    expect(result.claims.counts.own).toBe(5);
    expect(result.claims.own).toHaveLength(2);
  });
});

describe('getSessionBootstrap — Phase 2D conflict triage summary', () => {
  function denyConflict(repo: string, args: { claimId: string; requester: string; blocker: string }): void {
    recordConflict(repo, {
      conflict_type: 'claim_denied',
      detected_at: new Date().toISOString(),
      involved_claims: [args.claimId],
      involved_agents: [args.requester, args.blocker],
      involved_files: ['src/contested.ts'],
      severity: 'medium',
      description: 'Claim denied for src/contested.ts.',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });
  }

  test('still-blocking conflict is counted, surfaced with triage fields, and safely recommended', async () => {
    const repo = makeRepo('vibecode-bs-conflict-block-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/contested.ts', mode: 'exclusive' }, { claimId: 'claim-blk' });
    denyConflict(repo, { claimId: 'claim-blk', requester: a.agent_id, blocker: b.agent_id });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, ...baseOpts });
    expect(result.conflicts.unresolved_count).toBe(1);
    expect(result.conflicts.still_blocking_count).toBe(1);
    expect(result.conflicts.stale_blocking_count).toBe(0);
    expect(result.conflicts.cleared_count).toBe(0);
    const item = result.conflicts.items[0];
    expect(item.triage_status).toBe('still_blocking');
    expect(item.blocking_agent_id).toBe(b.agent_id);
    expect(item.blocking_agent_status).toBe('active');
    expect(item.warning_codes).toContain('CONFLICT_STILL_BLOCKING');
    expect(result.warnings.map((w) => w.code)).toContain('CONFLICTS_STILL_BLOCKING');
    expect(result.recommended_next_tools).toContain('vibecode_conflict_detail');
    expect(result.recommended_tool_profiles.map((p) => p.profile_id)).toContain('conflict_resolution');
    // Safety boundary: no recommendation suggests force cleanup, cross-agent
    // release, ownership transfer, or direct .vibecode editing.
    const recs = [...result.recommended_next_tools, ...result.recommended_cli_commands].join(' ');
    expect(recs).not.toMatch(/force|transfer|state\.json/i);
  });

  test('conflict whose blocking claim was released is cleared, not inconsistent', async () => {
    const repo = makeRepo('vibecode-bs-conflict-cleared-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/contested.ts', mode: 'exclusive' }, { claimId: 'claim-blk' });
    denyConflict(repo, { claimId: 'claim-blk', requester: a.agent_id, blocker: b.agent_id });
    releaseFileClaim(repo, 'claim-blk');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, ...baseOpts });
    expect(result.conflicts.unresolved_count).toBe(1);
    expect(result.conflicts.still_blocking_count).toBe(0);
    expect(result.conflicts.cleared_count).toBe(1);
    const item = result.conflicts.items[0];
    expect(item.triage_status).toBe('cleared');
    expect(item.warning_codes).toContain('CONFLICT_BLOCKING_CLAIM_RELEASED');
    expect(item.warning_codes).not.toContain('CONFLICT_REFERENCES_MISSING_CLAIM');
    expect(item.warning_codes).not.toContain('CONFLICT_OWNER_MISSING');
    expect(result.warnings.map((w) => w.code)).not.toContain('CONFLICTS_STILL_BLOCKING');
  });

  test('legacy conflict record with missing involved_* arrays does not crash bootstrap', async () => {
    const repo = makeRepo('vibecode-bs-conflict-legacy-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const stateFile = path.join(repo, '.vibecode', 'coordination', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.conflicts.push({
      conflict_id: 'conflict-legacy',
      conflict_type: 'claim_denied',
      detected_at: new Date().toISOString(),
      status: 'detected',
      severity: 'low',
      description: 'legacy record without involved_* arrays',
      evidence: { detector: 'claim_manager', details: {} },
    });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.conflicts.unresolved_count).toBe(1);
    expect(result.conflicts.items[0].conflict_id).toBe('conflict-legacy');
    expect(result.conflicts.items[0].involved_files).toEqual([]);
  });

  test('clean state: conflict triage counts are zero and no conflict warning is emitted', async () => {
    const repo = makeRepo('vibecode-bs-conflict-clean-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.conflicts).toMatchObject({
      unresolved_count: 0,
      still_blocking_count: 0,
      stale_blocking_count: 0,
      cleared_count: 0,
      items: [],
    });
    expect(result.warnings.map((w) => w.code)).not.toContain('CONFLICTS_STILL_BLOCKING');
  });
});

describe('getSessionBootstrap — stale active claim warnings for clean files', () => {
  // Deterministic clocks: agents register and claims are created at CLAIM_T0;
  // bootstrap runs either WITHIN the min-age grace (fresh claims stay quiet) or
  // PAST it (clean claimed files become possibly stale). Both offsets stay well
  // inside the 5-minute heartbeat TTL so the owning agents remain active.
  const CLAIM_T0 = '2026-03-01T00:00:00.000Z';
  const WITHIN_GRACE = new Date(Date.parse(CLAIM_T0) + 30_000).toISOString();
  const PAST_GRACE = new Date(
    Date.parse(CLAIM_T0) + POSSIBLY_STALE_ACTIVE_CLAIM_MIN_AGE_MS + 30_000,
  ).toISOString();

  function registerPair(repo: string): { a: string; b: string } {
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: CLAIM_T0 });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { now: CLAIM_T0 });
    return { a: a.agent_id, b: b.agent_id };
  }

  test('fresh other-agent active claim on a clean file is NOT flagged (min-age grace)', async () => {
    const repo = makeRepo('vibecode-bs-stale-fresh-');
    const { a, b } = registerPair(repo);
    // B just claimed src/theirs.ts and has not started editing yet — normal state.
    addFileClaim(repo, { agent_id: b, path: 'src/theirs.ts', mode: 'exclusive' }, { now: CLAIM_T0 });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, now: WITHIN_GRACE, ...baseOpts });
    const staleWarnings = result.warnings.filter((w) => w.code === 'POSSIBLY_STALE_ACTIVE_CLAIMS');
    expect(staleWarnings).toHaveLength(0);
    // The claim itself is still visible as other_active.
    expect(result.claims.counts.other_active).toBe(1);
  });

  test('claim older than the grace period on a clean file produces a POSSIBLY_STALE_ACTIVE_CLAIMS warning', async () => {
    const repo = makeRepo('vibecode-bs-stale-clean-');
    const { a, b } = registerPair(repo);
    // B claims src/theirs.ts but never dirties it (the file does not exist in the working tree).
    addFileClaim(repo, { agent_id: b, path: 'src/theirs.ts', mode: 'exclusive' }, { now: CLAIM_T0 });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, now: PAST_GRACE, ...baseOpts });
    const staleWarnings = result.warnings.filter((w) => w.code === 'POSSIBLY_STALE_ACTIVE_CLAIMS');
    expect(staleWarnings.length).toBeGreaterThan(0);
    const warning = staleWarnings[0];
    expect(warning.message).toContain('possibly stale');
    expect(warning.message).toContain('claims list');
    expect(warning.message).toContain('claims reap');
  });

  test('POSSIBLY_STALE_ACTIVE_CLAIMS warning includes claim ids, agent ids, and sample paths', async () => {
    const repo = makeRepo('vibecode-bs-stale-detail-');
    const { a, b } = registerPair(repo);
    addFileClaim(repo, { agent_id: b, path: 'src/clean1.ts', mode: 'exclusive' }, { now: CLAIM_T0 });
    addFileClaim(repo, { agent_id: b, path: 'src/clean2.ts', mode: 'shared' }, { now: CLAIM_T0 });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, now: PAST_GRACE, ...baseOpts });
    const staleWarnings = result.warnings.filter((w) => w.code === 'POSSIBLY_STALE_ACTIVE_CLAIMS');
    expect(staleWarnings.length).toBeGreaterThan(0);
    // The warning message should reference the claim details.
    const warning = staleWarnings[0];
    expect(warning.message).toContain(b);
    expect(warning.message).toContain('src/clean1.ts');
  });

  test('POSSIBLY_STALE_ACTIVE_CLAIMS warning is bounded by max_items', async () => {
    const repo = makeRepo('vibecode-bs-stale-bound-');
    const { a, b } = registerPair(repo);
    for (let i = 0; i < 10; i += 1) {
      addFileClaim(repo, { agent_id: b, path: `src/clean${i}.ts`, mode: 'exclusive' }, { now: CLAIM_T0 });
    }

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, max_items: 3, now: PAST_GRACE, ...baseOpts });
    const staleWarnings = result.warnings.filter((w) => w.code === 'POSSIBLY_STALE_ACTIVE_CLAIMS');
    // Should have at least one warning, and the details should be bounded.
    expect(staleWarnings.length).toBeGreaterThan(0);
  });

  test('old active other-agent claim on a dirty file is NOT flagged as stale', async () => {
    const repo = makeRepo('vibecode-bs-stale-dirty-');
    const { a, b } = registerPair(repo);
    // B claims src/theirs.ts AND the file is dirty in the working tree.
    addFileClaim(repo, { agent_id: b, path: 'src/theirs.ts', mode: 'exclusive' }, { now: CLAIM_T0 });
    write(repo, 'src/theirs.ts');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, now: PAST_GRACE, ...baseOpts });
    const staleWarnings = result.warnings.filter((w) => w.code === 'POSSIBLY_STALE_ACTIVE_CLAIMS');
    // The dirty-file claim should NOT be flagged as stale, even past the grace.
    expect(staleWarnings).toHaveLength(0);
    // The other_active claims summary should still work.
    expect(result.claims.counts.other_active).toBe(1);
  });

  test('existing other_active claims summary still works alongside stale warnings', async () => {
    const repo = makeRepo('vibecode-bs-stale-summary-');
    const { a, b } = registerPair(repo);
    // One clean-file claim (stale) and one dirty-file claim (legitimate).
    addFileClaim(repo, { agent_id: b, path: 'src/clean.ts', mode: 'exclusive' }, { now: CLAIM_T0 });
    addFileClaim(repo, { agent_id: b, path: 'src/dirty.ts', mode: 'exclusive' }, { now: CLAIM_T0 });
    write(repo, 'src/dirty.ts');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, now: PAST_GRACE, ...baseOpts });
    // Both claims are other_active.
    expect(result.claims.counts.other_active).toBe(2);
    // Only the clean-file claim produces a stale warning.
    const staleWarnings = result.warnings.filter((w) => w.code === 'POSSIBLY_STALE_ACTIVE_CLAIMS');
    expect(staleWarnings.length).toBeGreaterThan(0);
    expect(staleWarnings[0].message).toContain('src/clean.ts');
    expect(staleWarnings[0].message).not.toContain('src/dirty.ts');
  });

  test('recommended next commands include claims list and claims reap when stale warning present', async () => {
    const repo = makeRepo('vibecode-bs-stale-recs-');
    const { a, b } = registerPair(repo);
    addFileClaim(repo, { agent_id: b, path: 'src/clean.ts', mode: 'exclusive' }, { now: CLAIM_T0 });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, now: PAST_GRACE, ...baseOpts });
    expect(result.recommended_cli_commands.some((c) => c.includes('claims list'))).toBe(true);
    expect(result.recommended_cli_commands.some((c) => c.includes('claims reap'))).toBe(true);
    expect(result.recommended_next_tools).toContain('vibecode_claims_list');
    expect(result.recommended_next_tools).toContain('vibecode_claims_reap');
  });

  test('no grace period for real claim conflicts: fresh blocking claim still triages still_blocking', async () => {
    const repo = makeRepo('vibecode-bs-stale-conflict-');
    const { a, b } = registerPair(repo);
    addFileClaim(repo, { agent_id: b, path: 'src/contested.ts', mode: 'exclusive' }, { now: CLAIM_T0, claimId: 'claim-blk' });
    recordConflict(repo, {
      conflict_type: 'claim_denied',
      detected_at: CLAIM_T0,
      involved_claims: ['claim-blk'],
      involved_agents: [a, b],
      involved_files: ['src/contested.ts'],
      severity: 'medium',
      description: 'Claim denied for src/contested.ts.',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-fresh' });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a, now: WITHIN_GRACE, ...baseOpts });
    // The advisory stale warning is silenced by the grace period…
    expect(result.warnings.filter((w) => w.code === 'POSSIBLY_STALE_ACTIVE_CLAIMS')).toHaveLength(0);
    // …but the conflict is reported as still blocking immediately.
    expect(result.conflicts.still_blocking_count).toBe(1);
    expect(result.conflicts.items[0].triage_status).toBe('still_blocking');
  });
});

describe('getSessionBootstrap — releasable intent recommendations (Phase 2B)', () => {
  /** Write, stage, and commit a file so the claimed path starts CLEAN. */
  function commitFile(repo: string, rel: string): void {
    write(repo, rel);
    git(['add', rel], repo);
    git(['commit', '-q', '-m', `add ${rel}`], repo);
  }

  function buildWithIntent(repo: string): string {
    const a = registerAgent(repo, {
      agent_name: 'A',
      agent_type: 'codex',
      metadata: { operating_mode: 'build', task: 'alpha work' },
    });
    addBulkClaims({ repoRoot: repo, agent_id: a.agent_id, intent: 'alpha work', paths: ['src/alpha.ts'] });
    return a.agent_id;
  }

  test('active intent + clean tree → recommends intent release (dry-run first)', async () => {
    const repo = makeRepo('vibecode-bs-releasable-clean-');
    commitFile(repo, 'src/alpha.ts');
    const agentId = buildWithIntent(repo);

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agentId, ...baseOpts });
    expect(result.active_work_intents).toHaveLength(1);
    expect(result.recommended_next_tools).toContain('vibecode_claim_intents_list');
    expect(result.recommended_next_tools).toContain('vibecode_claim_intent_release');
    expect(result.recommended_cli_commands.some((c) => c.includes('intent-release') && c.includes('--dry-run'))).toBe(true);
  });

  test('active intent + dirty CLAIMED file → does NOT recommend release', async () => {
    const repo = makeRepo('vibecode-bs-releasable-dirty-');
    commitFile(repo, 'src/alpha.ts');
    const agentId = buildWithIntent(repo);
    // Modify the claimed file — release would block on it.
    write(repo, 'src/alpha.ts', 'changed\n');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agentId, ...baseOpts });
    expect(result.active_work_intents).toHaveLength(1);
    expect(result.recommended_next_tools).not.toContain('vibecode_claim_intent_release');
    expect(result.recommended_cli_commands.some((c) => c.includes('intent-release'))).toBe(false);
  });

  test('active intent + UNCLAIMED dirty file → does NOT recommend release', async () => {
    const repo = makeRepo('vibecode-bs-releasable-unclaimed-');
    commitFile(repo, 'src/alpha.ts');
    const agentId = buildWithIntent(repo);
    // Unclaimed work in flight — claim/commit it first, not release.
    write(repo, 'src/stray.ts');

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agentId, ...baseOpts });
    expect(result.active_work_intents).toHaveLength(1);
    expect(result.recommended_next_tools).not.toContain('vibecode_claim_intent_release');
  });

  test('released intent → no active intent and no release recommendation', async () => {
    const repo = makeRepo('vibecode-bs-releasable-released-');
    commitFile(repo, 'src/alpha.ts');
    const agentId = buildWithIntent(repo);
    const intentId = (await getSessionBootstrap({ repoRoot: repo, agent_id: agentId, ...baseOpts }))
      .active_work_intents[0].intent_id;
    releaseClaimIntent({ repoRoot: repo, agent_id: agentId, intent_id: intentId });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agentId, ...baseOpts });
    expect(result.active_work_intents).toHaveLength(0);
    expect(result.recommended_next_tools).not.toContain('vibecode_claim_intent_release');
  });
});
