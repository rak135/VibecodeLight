import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../src/core/coordination/agents.js';
import { listFileClaims, releaseFileClaim } from '../../src/core/coordination/claims.js';
import { addBulkClaims, listClaimIntents } from '../../src/core/coordination/bulk_claims.js';
import {
  listClaimIntentsDetail,
  releaseClaimIntent,
} from '../../src/core/coordination/intent_lifecycle.js';
import { loadCoordinationState } from '../../src/core/coordination/state.js';
import type { GitReadOnlyRunner } from '../../src/core/workspace/git_status.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function build(repoRoot: string, agentId: string): void {
  registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'codex', metadata: { operating_mode: 'build', task: 'work' } },
    { agentId },
  );
}

function cleanGitRunner(): GitReadOnlyRunner {
  return (args: string[]) => {
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc123', stderr: '', exitCode: 0 };
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  };
}

function dirtyGitRunner(dirtyPaths: string[]): GitReadOnlyRunner {
  return (args: string[]) => {
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'abc123', stderr: '', exitCode: 0 };
    if (args[0] === 'status') {
      return { ok: true, stdout: dirtyPaths.map((p) => ` M ${p}`).join('\n'), stderr: '', exitCode: 0 };
    }
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  };
}

describe('Phase 2B — full lifecycle integration', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-lifecycle-')));
  afterEach(() => repo.cleanup());

  test('complete lifecycle: create intent → dry-run release → release → no longer active', () => {
    build(repo.repoRoot, 'agent-a');

    // 1. Create intent via bulk claim.
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'implement alpha feature',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });
    expect(bulk.status).toBe('ok');
    expect(bulk.intent_id).toBeTruthy();

    // 2. List intents — should show active.
    const listBefore = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a' });
    expect(listBefore.intents).toHaveLength(1);
    expect(listBefore.intents[0].status).toBe('active');
    expect(listBefore.intents[0].active_claim_count).toBe(2);

    // 3. Dry-run release — should be allowed.
    const dryRun = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      dry_run: true,
      gitRunner: cleanGitRunner(),
    });
    expect(dryRun.release_allowed).toBe(true);
    expect(dryRun.released_claims).toHaveLength(2);

    // 4. Actual release.
    const release = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });
    expect(release.status).toBe('ok');
    expect(release.intent_status).toBe('released');

    // 5. Claims are released.
    const activeClaims = listFileClaims(repo.repoRoot);
    expect(activeClaims).toHaveLength(0);

    // 6. Intent no longer active.
    const intents = listClaimIntents(repo.repoRoot);
    expect(intents[0].status).toBe('released');

    // 7. List with default filter shows no intents.
    const listAfter = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a' });
    expect(listAfter.intents).toHaveLength(0);

    // 8. List with status=all shows the released intent.
    const listAll = listClaimIntentsDetail(repo.repoRoot, { agent_id: 'agent-a', status: 'all' });
    expect(listAll.intents).toHaveLength(1);
    expect(listAll.intents[0].status).toBe('released');
  });

  test('abandon lifecycle: create intent → edit (dirty) → release blocked → revert → release succeeds', () => {
    build(repo.repoRoot, 'agent-a');

    // 1. Create intent.
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'abandoned work',
      paths: ['src/beta.ts'],
    });

    // 2. "Edit" file — dirty git runner reports src/beta.ts as dirty.
    const dirtyDryRun = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      dry_run: true,
      gitRunner: dirtyGitRunner(['src/beta.ts']),
    });
    expect(dirtyDryRun.release_allowed).toBe(false);
    expect(dirtyDryRun.blocked_reason).toBe('dirty_claimed_files');
    expect(dirtyDryRun.dirty_claimed_paths).toEqual(['src/beta.ts']);

    // 3. Try actual release — also blocked.
    const dirtyRelease = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: dirtyGitRunner(['src/beta.ts']),
    });
    expect(dirtyRelease.status).toBe('blocked');
    expect(dirtyRelease.released_claims).toHaveLength(0);

    // 4. Intent still active.
    expect(listClaimIntents(repo.repoRoot)[0].status).toBe('active');

    // 5. "Revert" file — clean tree.
    const cleanRelease = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });
    expect(cleanRelease.status).toBe('ok');
    expect(cleanRelease.released_claims).toHaveLength(1);
  });

  test('two-agent safety: Agent A owns intent, Agent B cannot release it', () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');

    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'a-work',
      paths: ['src/a.ts'],
    });

    // Agent B tries to release Agent A's intent.
    expect(() => releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-b',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    })).toThrowError(/belongs to agent/);

    // Agent A can release.
    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });
    expect(result.status).toBe('ok');
  });

  test('idempotent release: releasing an already-released intent returns already_released', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work',
      paths: ['src/a.ts'],
    });

    releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });

    const second = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });
    expect(second.status).toBe('already_released');
    expect(second.intent_status).toBe('released');
  });

  test('partial release: some claims already released by single-file release', () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work',
      paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });

    // Release one claim via single-file release.
    const state = loadCoordinationState(repo.repoRoot);
    const claim = (state.claims as unknown as Array<{ claim_id: string; path: string }>).find((c) => c.path === 'src/b.ts')!;
    releaseFileClaim(repo.repoRoot, claim.claim_id);

    // Release by intent — releases remaining 2.
    const result = releaseClaimIntent({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: bulk.intent_id!,
      gitRunner: cleanGitRunner(),
    });
    expect(result.status).toBe('ok');
    expect(result.released_claims).toHaveLength(2);
    expect(result.already_released_claims).toHaveLength(1);
  });
});
