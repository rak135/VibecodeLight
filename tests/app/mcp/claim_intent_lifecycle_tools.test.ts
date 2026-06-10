import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaimIntentsListTool,
  buildClaimIntentReleaseTool,
} from '../../../src/app/mcp/tools/claim_intent_lifecycle.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';
import { loadCoordinationState } from '../../../src/core/coordination/state.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

/**
 * MCP handlers cannot inject a git runner, so clean/dirty release behavior is
 * exercised against a REAL `git init` working tree. A plain (non-git) temp dir
 * is used only for the fail-closed git-unavailable test.
 */
function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const init = spawnSync('git', ['init', '-q'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function makeNonGitDir(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function writeFile(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function build(repoRoot: string, agentId: string): void {
  registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'codex', metadata: { operating_mode: 'build', task: 'work' } },
    { agentId },
  );
}

describe('VibecodeMCP Phase 2B claim intents list tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-list-mcp-')));
  afterEach(() => repo.cleanup());

  test('vibecode_claim_intents_list returns active intents', async () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    const tool = buildClaimIntentsListTool();
    expect(tool.name).toBe('vibecode_claim_intents_list');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a' },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { intents: Array<{ intent: string; claim_count: number }> };
    expect(data.intents).toHaveLength(1);
    expect(data.intents[0].intent).toBe('work on alpha');
    expect(data.intents[0].claim_count).toBe(2);
  });

  test('is read-only — does not mutate state', async () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });

    const before = loadCoordinationState(repo.repoRoot);
    await buildClaimIntentsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a' },
      requestId: null,
    });
    const after = loadCoordinationState(repo.repoRoot);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test('rejects unknown fields', async () => {
    build(repo.repoRoot, 'agent-a');
    const result = await buildClaimIntentsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', unknown_field: 'x' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('includes owner lifecycle fields (Phase 2C)', async () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'alpha', paths: ['src/a.ts'] });

    const result = await buildClaimIntentsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      intents: Array<{ owning_agent_status: string; warning_codes: string[]; missing_claim_count: number }>;
    };
    expect(data.intents[0].owning_agent_status).toBe('active');
    expect(data.intents[0].warning_codes).toEqual([]);
    expect(data.intents[0].missing_claim_count).toBe(0);
  });

  test('surfaces a terminated owner with INTENT_OWNER_TERMINATED (Phase 2C)', async () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'alpha', paths: ['src/a.ts'] });
    markAgentTerminated(repo.repoRoot, 'agent-a');

    const result = await buildClaimIntentsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      intents: Array<{ owning_agent_status: string; warning_codes: string[] }>;
    };
    expect(data.intents[0].owning_agent_status).toBe('terminated');
    expect(data.intents[0].warning_codes).toContain('INTENT_OWNER_TERMINATED');
  });

  test('filters by status', async () => {
    build(repo.repoRoot, 'agent-a');
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'first', paths: ['src/a.ts'] });

    // Active only (default).
    const active = await buildClaimIntentsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', status: 'active' },
      requestId: null,
    });
    expect((active.structuredContent.data as { intents: unknown[] }).intents).toHaveLength(1);

    // Released only — none.
    const released = await buildClaimIntentsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', status: 'released' },
      requestId: null,
    });
    expect((released.structuredContent.data as { intents: unknown[] }).intents).toHaveLength(0);
  });
});

describe('VibecodeMCP Phase 2B claim intent release tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-rel-mcp-')));
  afterEach(() => repo.cleanup());

  test('vibecode_claim_intent_release dry-run on clean intent', async () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });

    const tool = buildClaimIntentReleaseTool();
    expect(tool.name).toBe('vibecode_claim_intent_release');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent_id: bulk.intent_id!, dry_run: true },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { release_allowed: boolean; status: string; released_claims: unknown[] };
    expect(data.release_allowed).toBe(true);
    expect(data.status).toBe('ok');
    expect(data.released_claims).toHaveLength(1);

    // State NOT mutated.
    const intents = loadCoordinationState(repo.repoRoot).intents as unknown as Array<{ status: string }>;
    expect(intents[0].status).toBe('active');
  });

  test('release on clean intent actually releases', async () => {
    build(repo.repoRoot, 'agent-a');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });

    const result = await buildClaimIntentReleaseTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent_id: bulk.intent_id!, dry_run: false },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { status: string; released_claims: unknown[]; intent_status: string };
    expect(data.status).toBe('ok');
    expect(data.released_claims).toHaveLength(2);
    expect(data.intent_status).toBe('released');

    // Intent is now released.
    const intents = loadCoordinationState(repo.repoRoot).intents as unknown as Array<{ status: string }>;
    expect(intents[0].status).toBe('released');
  });

  test('blocks release when claimed files are dirty (real git tree)', async () => {
    build(repo.repoRoot, 'agent-a');
    // The claimed file exists and is untracked → dirty in the working tree.
    writeFile(repo.repoRoot, 'src/alpha.ts');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'work on alpha',
      paths: ['src/alpha.ts'],
    });

    const result = await buildClaimIntentReleaseTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent_id: bulk.intent_id!, dry_run: false },
      requestId: null,
    });

    // Blocked is an ok-envelope result with release_allowed: false.
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      status: string; release_allowed: boolean; blocked_reason: string | null;
      released_claims: unknown[]; dirty_claimed_paths: string[];
    };
    expect(data.status).toBe('blocked');
    expect(data.release_allowed).toBe(false);
    expect(data.blocked_reason).toBe('dirty_claimed_files');
    expect(data.dirty_claimed_paths).toEqual(['src/alpha.ts']);
    expect(data.released_claims).toHaveLength(0);

    // Intent stays active.
    const intents = loadCoordinationState(repo.repoRoot).intents as unknown as Array<{ status: string }>;
    expect(intents[0].status).toBe('active');
  });

  test('blocks release fail-closed when git is unavailable (non-git workspace)', async () => {
    const nonGit = makeNonGitDir('vibecode-intent-rel-nogit-');
    try {
      build(nonGit.repoRoot, 'agent-a');
      const bulk = addBulkClaims({
        repoRoot: nonGit.repoRoot,
        agent_id: 'agent-a',
        intent: 'work without git',
        paths: ['src/alpha.ts'],
      });

      const result = await buildClaimIntentReleaseTool().handler({
        context: ctx(nonGit.repoRoot),
        arguments: { agent_id: 'agent-a', intent_id: bulk.intent_id! },
        requestId: null,
      });

      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        status: string; release_allowed: boolean; blocked_reason: string | null; released_claims: unknown[];
      };
      expect(data.status).toBe('blocked');
      expect(data.release_allowed).toBe(false);
      expect(data.blocked_reason).toBe('git_unavailable');
      expect(data.released_claims).toHaveLength(0);

      const intents = loadCoordinationState(nonGit.repoRoot).intents as unknown as Array<{ status: string }>;
      expect(intents[0].status).toBe('active');
    } finally {
      nonGit.cleanup();
    }
  });

  test('blocks release for another agent intent', async () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');
    const bulk = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'a-work',
      paths: ['src/a.ts'],
    });

    const result = await buildClaimIntentReleaseTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-b', intent_id: bulk.intent_id! },
      requestId: null,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INTENT_FORBIDDEN');
  });

  test('blocks release for missing intent', async () => {
    build(repo.repoRoot, 'agent-a');

    const result = await buildClaimIntentReleaseTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent_id: 'intent-nonexistent' },
      requestId: null,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INTENT_NOT_FOUND');
  });

  test('rejects unknown fields', async () => {
    build(repo.repoRoot, 'agent-a');
    const result = await buildClaimIntentReleaseTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent_id: 'intent-x', bad_field: true },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('requires agent_id and intent_id', async () => {
    build(repo.repoRoot, 'agent-a');
    const result = await buildClaimIntentReleaseTool().handler({
      context: ctx(repo.repoRoot),
      arguments: {},
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });
});
