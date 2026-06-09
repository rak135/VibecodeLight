import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { heartbeatAgent, registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim, listFileClaims } from '../../../src/core/coordination/claims.js';
import { planClaims } from '../../../src/core/coordination/claim_planning.js';
import { addBulkClaims, listClaimIntents } from '../../../src/core/coordination/bulk_claims.js';
import { CoordinationError } from '../../../src/core/coordination/errors.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import { listConflicts } from '../../../src/core/coordination/conflicts.js';
import { loadCoordinationState } from '../../../src/core/coordination/state.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function build(repoRoot: string, agentId: string, now?: string): void {
  registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'codex', metadata: { operating_mode: 'build', task: 'work' } },
    { agentId, ...(now ? { now } : {}) },
  );
}

describe('Phase 2A — planClaims (read-only)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-plan-')));
  afterEach(() => repo.cleanup());

  test('build agent: classifies claimable paths and recommends add-bulk', () => {
    build(repo.repoRoot, 'agent-a');
    fs.writeFileSync(path.join(repo.repoRoot, 'a.ts'), 'x', 'utf8');
    const stateFile = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const before = fs.readFileSync(stateFile, 'utf8');

    const plan = planClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'add alpha',
      paths: ['a.ts', 'tests/a.test.ts'],
    });

    expect(plan.agent_mode).toBe('build');
    expect(plan.can_claim_all).toBe(true);
    expect(plan.atomic).toBe(true);
    expect(plan.paths.map((p) => p.status)).toEqual(['claimable', 'missing']);
    expect(plan.claimable_paths).toEqual(['a.ts', 'tests/a.test.ts']);
    expect(plan.recommended_cli_commands[0]).toContain('claims add-bulk');
    expect(plan.recommended_cli_commands[0]).toContain('--path a.ts');
    // Read-only: planClaims never mutates coordination state.
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
  });

  test('blocks read_only agents', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'ro', agent_type: 'codex', metadata: { operating_mode: 'read_only', task: 'review' } },
      { agentId: 'agent-ro' },
    );
    expect(() => planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-ro', paths: ['a.ts'] }))
      .toThrowError(/read_only/i);
  });

  test('blocks legacy agents without an operating mode', () => {
    registerAgent(repo.repoRoot, { agent_name: 'legacy', agent_type: 'codex', metadata: {} }, { agentId: 'agent-legacy' });
    try {
      planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-legacy', paths: ['a.ts'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('INVALID_AGENT_MODE');
    }
  });

  test('detects already-owned, other-agent, and stale overlaps', () => {
    const t0 = '2026-06-06T00:00:00.000Z';
    build(repo.repoRoot, 'agent-a', t0);
    build(repo.repoRoot, 'agent-b', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/a.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-a-own' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-b', path: 'src/b.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-b-other' });

    const plan = planClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      now: t0,
    });

    const byPath = Object.fromEntries(plan.paths.map((p) => [p.path, p]));
    expect(byPath['src/a.ts'].status).toBe('already_claimed_by_agent');
    expect(byPath['src/a.ts'].claim_id).toBe('claim-a-own');
    expect(byPath['src/b.ts'].status).toBe('claimed_by_other_active_agent');
    expect(byPath['src/b.ts'].conflicting_claims?.[0].claim_id).toBe('claim-b-other');
    expect(byPath['src/c.ts'].status).toBe('missing');
    expect(plan.can_claim_all).toBe(false);
    expect(plan.already_owned_paths).toEqual(['src/a.ts']);
    expect(plan.blocked_paths).toEqual(['src/b.ts']);
  });

  test('detects a stale-claim overlap (does not block)', () => {
    const t0 = '2026-06-06T00:00:00.000Z';
    build(repo.repoRoot, 'agent-stale', t0);
    build(repo.repoRoot, 'agent-live', t0);
    addFileClaim(repo.repoRoot, { agent_id: 'agent-stale', path: 'src/x.ts', mode: 'exclusive' }, { now: t0, claimId: 'claim-stale' });

    const later = new Date(Date.parse(t0) + HEARTBEAT_TTL_MS + 1000).toISOString();
    heartbeatAgent(repo.repoRoot, 'agent-live', { now: later });

    const plan = planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-live', paths: ['src/x.ts'], now: later });
    expect(plan.paths[0].status).toBe('stale_claim_overlap');
    expect(plan.paths[0].stale_claim_id).toBe('claim-stale');
    expect(plan.can_claim_all).toBe(true);
  });

  test('rejects an empty path list', () => {
    build(repo.repoRoot, 'agent-a');
    expect(() => planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: [] }))
      .toThrowError(/NO_CLAIM_PATHS|at least one/i);
  });

  test('classifies traversal/outside-repo and .vibecode paths as invalid', () => {
    build(repo.repoRoot, 'agent-a');
    const plan = planClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      paths: ['..\\outside.ts', '.vibecode/coordination/state.json'],
    });
    expect(plan.paths.every((p) => p.status === 'invalid')).toBe(true);
    expect(plan.can_claim_all).toBe(false);
  });

  test('dedupes duplicate normalized paths deterministically (first wins)', () => {
    build(repo.repoRoot, 'agent-a');
    const plan = planClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      paths: ['src/a.ts', './src/a.ts', 'src/a.ts'],
    });
    expect(plan.paths).toHaveLength(1);
    expect(plan.paths[0].path).toBe('src/a.ts');
  });
});

describe('Phase 2A — addBulkClaims (atomic mutating)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-bulk-')));
  afterEach(() => repo.cleanup());

  test('creates multiple claims atomically and records intent metadata', () => {
    build(repo.repoRoot, 'agent-a');
    const result = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'add alpha feature',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    expect(result.status).toBe('ok');
    expect(result.created_claims.map((c) => c.path)).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
    expect(result.intent_id).toMatch(/^intent-/);
    expect(result.intent).toBe('add alpha feature');

    const claims = listFileClaims(repo.repoRoot);
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(claim.metadata).toMatchObject({ intent_id: result.intent_id, intent: 'add alpha feature' });
      expect(claim.mode).toBe('exclusive');
      expect(claim.status).toBe('active');
    }

    const intents = listClaimIntents(repo.repoRoot);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      intent_id: result.intent_id,
      agent_id: 'agent-a',
      intent: 'add alpha feature',
      status: 'active',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });
    expect(intents[0].claim_ids).toHaveLength(2);

    // Agent's active claim list reflects the new claims.
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.agents[0].claims).toHaveLength(2);
  });

  test('is idempotent for paths already owned by the same agent', () => {
    build(repo.repoRoot, 'agent-a');
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/alpha.ts', mode: 'exclusive' }, { claimId: 'claim-existing' });

    const result = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'add alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    expect(result.status).toBe('ok');
    expect(result.already_owned_paths).toEqual(['src/alpha.ts']);
    expect(result.created_claims.map((c) => c.path)).toEqual(['tests/alpha.test.ts']);
    expect(listFileClaims(repo.repoRoot)).toHaveLength(2); // no duplicate for alpha.ts
  });

  test('blocks atomically when one path conflicts and creates zero new claims', () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');
    addFileClaim(repo.repoRoot, { agent_id: 'agent-b', path: 'src/beta.ts', mode: 'exclusive' }, { claimId: 'claim-b' });

    const before = loadCoordinationState(repo.repoRoot).claims.length;
    const result = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'add alpha',
      paths: ['src/alpha.ts', 'src/beta.ts'],
    });

    expect(result.status).toBe('blocked');
    expect(result.created_claims).toEqual([]);
    expect(result.blocked_paths.map((b) => b.path)).toEqual(['src/beta.ts']);
    expect(result.blocked_paths[0].reason).toBe('claimed_by_other_active_agent');
    expect(result.conflict_id).toMatch(/^conflict-/);

    // Zero new claims created; the only added record is the advisory conflict.
    expect(loadCoordinationState(repo.repoRoot).claims.length).toBe(before);
    expect(listClaimIntents(repo.repoRoot)).toHaveLength(0);
    expect(listConflicts(repo.repoRoot)).toHaveLength(1);
  });

  test('extends an existing intent with new explicit paths', () => {
    build(repo.repoRoot, 'agent-a');
    const first = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'add alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    const extended = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: first.intent_id ?? undefined,
      paths: ['package-lock.json', 'src/index.ts'],
    });

    expect(extended.status).toBe('ok');
    expect(extended.intent_id).toBe(first.intent_id);
    expect(extended.created_claims.map((c) => c.path)).toEqual(['package-lock.json', 'src/index.ts']);

    const intents = listClaimIntents(repo.repoRoot);
    expect(intents).toHaveLength(1);
    expect(intents[0].paths).toEqual(['src/alpha.ts', 'tests/alpha.test.ts', 'package-lock.json', 'src/index.ts']);
    expect(intents[0].claim_ids).toHaveLength(4);
    expect(listFileClaims(repo.repoRoot)).toHaveLength(4);
  });

  test('cannot extend another agent’s intent', () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');
    const a = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'a-work', paths: ['src/a.ts'] });

    try {
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-b', intent_id: a.intent_id ?? undefined, paths: ['src/b.ts'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('INTENT_FORBIDDEN');
    }
  });

  test('cannot extend a missing intent', () => {
    build(repo.repoRoot, 'agent-a');
    try {
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent_id: 'intent-does-not-exist', paths: ['src/a.ts'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('INTENT_NOT_FOUND');
    }
  });

  test('requires a non-empty intent when creating a new work scope', () => {
    build(repo.repoRoot, 'agent-a');
    try {
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: '   ', paths: ['src/a.ts'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('INVALID_INTENT');
    }
  });

  test('blocks read_only agents from bulk claiming', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'ro', agent_type: 'codex', metadata: { operating_mode: 'read_only', task: 'review' } },
      { agentId: 'agent-ro' },
    );
    expect(() => addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-ro', intent: 'x', paths: ['a.ts'] }))
      .toThrowError(/read_only/i);
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(true);
  });

  test('single-file addFileClaim still works alongside bulk-created claims', () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'bulk', paths: ['src/a.ts'] });
    const single = addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/b.ts', mode: 'exclusive' });
    expect(single.denied).toBe(false);
    expect(listFileClaims(repo.repoRoot).map((c) => c.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
