import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

/**
 * Fake git runner that reports specific paths as dirty.
 *
 * Emits real `--porcelain=v1 -z` output: each entry is `XY PATH` terminated by
 * a NUL — NOT newline-separated — so multi-path and space-containing paths
 * parse exactly like real git.
 */
function fakeGitRunner(dirtyPaths: string[]): GitReadOnlyRunner {
  return (args: string[], _repoRoot: string) => {
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc123', stderr: '', exitCode: 0 };
    if (args[0] === 'status') {
      const out = dirtyPaths.map((p) => ` M ${p}\u0000`).join('');
      return { ok: true, stdout: out, stderr: '', exitCode: 0 };
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

/** Fake git runner where git itself is unavailable (not a repo / no binary). */
function failingGitRunner(): GitReadOnlyRunner {
  return (_args: string[], _repoRoot: string) => ({
    ok: false,
    stdout: '',
    stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    exitCode: 128,
  });
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

  test('bounds sample_paths at 10 entries while keeping full paths', () => {
    build(repo.repoRoot, 'agent-a');
    const paths = Array.from({ length: 12 }, (_, i) => `src/file_${String(i).padStart(2, '0')}.ts`);
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'many paths', paths });

    const result = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a' });
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].paths).toHaveLength(12);
    expect(result.intents[0].sample_paths).toHaveLength(10);
    expect(result.intents[0].sample_paths).toEqual(paths.slice(0, 10));
    expect(result.intents[0].sample_truncated).toBe(true);
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

  test('clean release performs exactly ONE coordination state write', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts', 'src/utils.ts'],
    });

    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      releaseClaimIntent({
        repoRoot: repo.repoRoot,
        agent_id: 'agent-a',
        intent_id: bulk.intent_id!,
        gitRunner: cleanGitRunner(),
      });
      const stateWrites = spy.mock.calls.filter((call) => String(call[0]).endsWith('state.json'));
      expect(stateWrites).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }

    // The single write released all claims AND the intent together.
    expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
    expect(listClaimIntents(repo.repoRoot)[0].status).toBe('released');
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

// ---------------------------------------------------------------------------
// Phase 2B follow-up — fail-closed when git is unavailable
// ---------------------------------------------------------------------------

describe('Phase 2B — releaseClaimIntent fail-closed without git', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-nogit-')));
  afterEach(() => repo.cleanup());

  test('dry-run blocks with git_unavailable and mutates nothing', () => {
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
      dry_run: true,
      gitRunner: failingGitRunner(),
    });

    expect(result.release_allowed).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blocked_reason).toBe('git_unavailable');
    expect(result.released_claims).toHaveLength(0);
    expect(result.dirty_claimed_paths).toEqual([]);
    expect(result.warnings.some((w) => w.includes('git'))).toBe(true);
    // Nothing mutated.
    expect(listClaimIntents(repo.repoRoot)[0].status).toBe('active');
    expect(listFileClaims(repo.repoRoot)).toHaveLength(1);
  });

  test('actual release blocks with git_unavailable and releases zero claims', () => {
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
      gitRunner: failingGitRunner(),
    });

    expect(result.release_allowed).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blocked_reason).toBe('git_unavailable');
    expect(result.released_claims).toHaveLength(0);
    expect(result.recommended_cli_commands.some((c) => c.includes('git changes'))).toBe(true);

    // Intent stays active, all claims stay active.
    expect(listClaimIntents(repo.repoRoot)[0].status).toBe('active');
    expect(listFileClaims(repo.repoRoot).filter((c) => c.status === 'active')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 2B follow-up — dirty detection parses real NUL-separated porcelain
// ---------------------------------------------------------------------------

describe('Phase 2B — dirty detection porcelain parsing', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-porcelain-')));
  afterEach(() => repo.cleanup());

  test('multiple dirty entries are all detected (NUL-separated)', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      dry_run: true,
      gitRunner: fakeGitRunner(['src/a.ts', 'src/c.ts']),
    });

    expect(result.status).toBe('blocked');
    expect(result.blocked_reason).toBe('dirty_claimed_files');
    expect(result.dirty_claimed_paths).toEqual(['src/a.ts', 'src/c.ts']);
  });

  test('dirty path containing spaces is detected', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work with spaces',
      paths: ['src/a file.ts'],
    });

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      dry_run: true,
      gitRunner: fakeGitRunner(['src/a file.ts']),
    });

    expect(result.status).toBe('blocked');
    expect(result.dirty_claimed_paths).toEqual(['src/a file.ts']);
  });
});

// ---------------------------------------------------------------------------
// Phase 2B follow-up — ownership and intent scoping
// ---------------------------------------------------------------------------

describe('Phase 2B — release ownership and intent scoping', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-scope-')));
  afterEach(() => repo.cleanup());

  test('intent referencing another agent claim does not release that claim', () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');
    const bulkA = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'a-work',
      paths: ['src/a.ts'],
    });
    addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-b',
      intent: 'b-work',
      paths: ['src/b.ts'],
    });

    // Hand-edit state: inject agent-b's claim into agent-a's intent. Normal
    // bulk_claims can never produce this; release must still not cross owners.
    const stateFile = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
      claims: Array<{ claim_id: string; agent_id: string }>;
      intents: Array<{ intent_id: string; claim_ids: string[] }>;
    };
    const bClaim = raw.claims.find((c) => c.agent_id === 'agent-b')!;
    const aIntent = raw.intents.find((i) => i.intent_id === bulkA.intent_id)!;
    aIntent.claim_ids.push(bClaim.claim_id);
    fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2), 'utf8');

    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulkA.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    expect(result.status).toBe('ok');
    expect(result.released_claims).toHaveLength(1);
    expect(result.released_claims[0].path).toBe('src/a.ts');
    expect(result.warnings.some((w) => w.includes('another agent'))).toBe(true);

    // agent-b's claim is untouched.
    const active = listFileClaims(repo.repoRoot);
    expect(active).toHaveLength(1);
    expect(active[0].agent_id).toBe('agent-b');
    expect(active[0].path).toBe('src/b.ts');
  });

  test('releasing one intent does not release another intent claims', () => {
    build(repo.repoRoot, 'agent-a');
    const first = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'first',
      paths: ['src/a.ts'],
    });
    const second = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'second',
      paths: ['src/b.ts'],
    });

    releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: first.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    const active = listFileClaims(repo.repoRoot);
    expect(active).toHaveLength(1);
    expect(active[0].path).toBe('src/b.ts');
    const intents = listClaimIntents(repo.repoRoot);
    expect(intents.find((i) => i.intent_id === first.intent_id)?.status).toBe('released');
    expect(intents.find((i) => i.intent_id === second.intent_id)?.status).toBe('active');
  });

  test('same-agent path overlap: only the claim-owning intent releases coverage', () => {
    build(repo.repoRoot, 'agent-a');
    const first = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'first',
      paths: ['src/shared.ts'],
    });
    // Second intent declares the same path: idempotent already-owned — the
    // claim stays attached to the FIRST intent only.
    const second = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'second',
      paths: ['src/shared.ts', 'src/other.ts'],
    });
    expect(second.already_owned_paths).toContain('src/shared.ts');

    // Releasing the first intent releases the shared claim coverage, even
    // though the second intent also lists the path (it never owned the claim).
    const releaseFirst = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: first.intent_id!,
      gitRunner: cleanGitRunner(),
    });
    expect(releaseFirst.status).toBe('ok');
    expect(releaseFirst.released_claims.map((c) => c.path)).toEqual(['src/shared.ts']);

    // The second intent still works and releases only its own claim — it does
    // NOT own (or re-release) the shared path's claim. Fails safe: the shared
    // path is simply unclaimed now.
    const releaseSecond = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: second.intent_id!,
      gitRunner: cleanGitRunner(),
    });
    expect(releaseSecond.status).toBe('ok');
    expect(releaseSecond.released_claims.map((c) => c.path)).toEqual(['src/other.ts']);
    expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
  });
});
