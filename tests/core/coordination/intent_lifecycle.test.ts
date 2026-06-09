import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim, listFileClaims, releaseFileClaim } from '../../../src/core/coordination/claims.js';
import { addBulkClaims, listClaimIntents } from '../../../src/core/coordination/bulk_claims.js';
import {
  listClaimIntentsDetail,
  releaseClaimIntent,
} from '../../../src/core/coordination/intent_lifecycle.js';
import { loadCoordinationState } from '../../../src/core/coordination/state.js';
import type { GitReadOnlyRunner } from '../../../src/core/workspace/git_status.js';

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

/** Fake git runner that reports specific paths as dirty. */
function fakeGitRunner(dirtyPaths: string[]): GitReadOnlyRunner {
  return (args: string[], _repoRoot: string) => {
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc123', stderr: '', exitCode: 0 };
    if (args[0] === 'status') {
      const lines = dirtyPaths.map((p) => ` M ${p}`);
      return { ok: true, stdout: lines.join('\n'), stderr: '', exitCode: 0 };
    }
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  };
}

/** Fake git runner that reports no dirty files (clean tree). */
function cleanGitRunner(): GitReadOnlyRunner {
  return (args: string[], _repoRoot: string) => {
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc123', stderr: '', exitCode: 0 };
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  };
}

// ---------------------------------------------------------------------------
// Phase 2B — listClaimIntentsDetail
// ---------------------------------------------------------------------------

describe('Phase 2B — listClaimIntentsDetail', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-list-')));
  afterEach(() => repo.cleanup());

  test('returns empty array when no intents exist', () => {
    build(repo.repoRoot, 'agent-a');
    const result = listClaimIntentsDetail(repo.repoRoot);
    expect(result.intents).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test('returns active intents for agent with claim detail', () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    const result = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a' });
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].intent).toBe('work on alpha');
    expect(result.intents[0].status).toBe('active');
    expect(result.intents[0].claim_count).toBe(2);
    expect(result.intents[0].active_claim_count).toBe(2);
    expect(result.intents[0].released_claim_count).toBe(0);
    expect(result.intents[0].paths).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
  });

  test('excludes released intents by default (status=active)', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });
    // Release the intent.
    releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    const result = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a' });
    expect(result.intents).toHaveLength(0);
  });

  test('can include released intents with status=all', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });
    releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    const result = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a', status: 'all' });
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].status).toBe('released');
    expect(result.intents[0].released_claim_count).toBe(1);
  });

  test('can filter by intent_id', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk1 = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'first',
      paths: ['src/a.ts'],
    });
    addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'second',
      paths: ['src/b.ts'],
    });

    const result = listClaimIntentsDetail(repo.repoRoot, {
      agent_id: 'agent-a',
      intent_id: bulk1.intent_id!,
    });
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].intent).toBe('first');
  });

  test('truncates at max_items', () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'first', paths: ['src/a.ts'] });
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'second', paths: ['src/b.ts'] });

    const result = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a', max_items: 1 });
    expect(result.intents).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test('filters by agent_id', () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'a-work', paths: ['src/a.ts'] });
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-b', intent: 'b-work', paths: ['src/b.ts'] });

    const result = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a' });
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].agent_id).toBe('agent-a');
  });

  test('old state without intents returns empty', () => {
    build(repo.repoRoot, 'agent-a');
    // Manually clear intents from state to simulate old format.
    const stateFile = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete raw.intents;
    fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2), 'utf8');

    const result = listClaimIntentsDetail(repo.repoRoot);
    expect(result.intents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2B — releaseClaimIntent dry-run
// ---------------------------------------------------------------------------

describe('Phase 2B — releaseClaimIntent dry-run', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-dry-')));
  afterEach(() => repo.cleanup());

  test('clean intent returns release_allowed true and claims_to_release', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      dry_run: true,
      gitRunner: cleanGitRunner(),
    });

    expect(result.dry_run).toBe(true);
    expect(result.release_allowed).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.released_claims).toHaveLength(2);
    expect(result.dirty_claimed_paths).toEqual([]);
    expect(result.recommended_cli_commands[0]).toContain('intent-release');
    // State is NOT mutated.
    const intents = listClaimIntents(repo.repoRoot);
    expect(intents[0].status).toBe('active');
  });

  test('dirty intent blocks with dirty_claimed_paths', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      dry_run: true,
      gitRunner: fakeGitRunner(['src/alpha.ts']),
    });

    expect(result.release_allowed).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blocked_reason).toBe('dirty_claimed_files');
    expect(result.dirty_claimed_paths).toEqual(['src/alpha.ts']);
    expect(result.released_claims).toHaveLength(0);
    expect(result.recommended_cli_commands.some((c) => c.includes('git changes'))).toBe(true);
  });

  test('throws for missing intent', () => {
    build(repo.repoRoot, 'agent-a');
    expect(() => releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: 'intent-nonexistent',
      dry_run: true,
      gitRunner: cleanGitRunner(),
    })).toThrowError(/No work intent found/);
  });

  test('throws for another agent intent', () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'a-work',
      paths: ['src/a.ts'],
    });

    expect(() => releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-b',
      intent_id: bulk.intent_id!,
      dry_run: true,
      gitRunner: cleanGitRunner(),
    })).toThrowError(/belongs to agent/);
  });
});

// ---------------------------------------------------------------------------
// Phase 2B — releaseClaimIntent mutation
// ---------------------------------------------------------------------------

describe('Phase 2B — releaseClaimIntent mutation', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-rel-')));
  afterEach(() => repo.cleanup());

  test('releases all active claims and marks intent released', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    expect(result.status).toBe('ok');
    expect(result.release_allowed).toBe(true);
    expect(result.released_claims).toHaveLength(2);
    expect(result.intent_status).toBe('released');

    // Claims are now released.
    const claims = listFileClaims(repo.repoRoot, { includeReleased: true });
    expect(claims.filter((c) => c.status === 'released')).toHaveLength(2);

    // Intent is marked released.
    const intents = listClaimIntents(repo.repoRoot);
    expect(intents[0].status).toBe('released');
    const state = loadCoordinationState(repo.repoRoot);
    const intentRecord = (state.intents as unknown as Array<Record<string, unknown>>).find(
      (i) => i.intent_id === bulk.intent_id,
    );
    expect(intentRecord?.released_at).toBeTruthy();
    expect(intentRecord?.released_by_agent_id).toBe('agent-a');
  });

  test('blocks dirty intent and releases zero claims', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: fakeGitRunner(['src/alpha.ts']),
    });

    expect(result.status).toBe('blocked');
    expect(result.released_claims).toHaveLength(0);

    // Intent remains active.
    const intents = listClaimIntents(repo.repoRoot);
    expect(intents[0].status).toBe('active');

    // Claims remain active.
    const claims = listFileClaims(repo.repoRoot);
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe('active');
  });

  test('already released intent returns idempotent response', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });

    // First release.
    releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    // Second release — idempotent.
    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    expect(result.status).toBe('already_released');
    expect(result.intent_status).toBe('released');
  });

  test('release intent with some already-released claims handles gracefully', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    // Release one claim directly.
    const state = loadCoordinationState(repo.repoRoot);
    const claimToRelease = (state.claims as unknown as Array<{ claim_id: string; path: string }>).find(
      (c) => c.path === 'src/alpha.ts',
    )!;
    releaseFileClaim(repo.repoRoot, claimToRelease.claim_id);

    // Release by intent — should release the remaining active claim.
    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    expect(result.status).toBe('ok');
    expect(result.released_claims).toHaveLength(1);
    expect(result.already_released_claims).toHaveLength(1);
  });

  test('existing single-file release still works alongside intent release', () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'bulk work',
      paths: ['src/a.ts'],
    });
    const single = addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/b.ts', mode: 'exclusive' });
    expect(single.denied).toBe(false);

    // Single-file release still works.
    releaseFileClaim(repo.repoRoot, single.claim!.claim_id);
    expect(listFileClaims(repo.repoRoot).filter((c) => c.status === 'active')).toHaveLength(1);
  });

  test('release is atomic: all active claims release or none', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts', 'src/utils.ts'],
    });

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    expect(result.status).toBe('ok');
    expect(result.released_claims).toHaveLength(3);

    // All claims released.
    const active = listFileClaims(repo.repoRoot);
    expect(active).toHaveLength(0);
  });

  test('empty intent with no active claims still marks released', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });

    // Release the claim directly first.
    const state = loadCoordinationState(repo.repoRoot);
    const claim = (state.claims as unknown as Array<{ claim_id: string }>)[0];
    releaseFileClaim(repo.repoRoot, claim.claim_id);

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    expect(result.status).toBe('ok');
    expect(result.released_claims).toHaveLength(0);
    expect(result.warnings[0]).toContain('already-released');
    expect(result.intent_status).toBe('released');
  });
});
