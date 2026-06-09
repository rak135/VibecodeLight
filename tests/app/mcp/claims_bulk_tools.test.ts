import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaimsPlanTool,
  buildClaimsAddBulkTool,
} from '../../../src/app/mcp/tools/claims_bulk.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { loadCoordinationState } from '../../../src/core/coordination/state.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

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

describe('VibecodeMCP Phase 2A claim plan / bulk tools', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-bulk-mcp-')));
  afterEach(() => repo.cleanup());

  test('vibecode_claims_plan classifies explicit paths read-only', async () => {
    build(repo.repoRoot, 'agent-a');
    const tool = buildClaimsPlanTool();
    expect(tool.name).toBe('vibecode_claims_plan');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent: 'add alpha', paths: ['src/alpha.ts', 'tests/alpha.test.ts'] },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { can_claim_all: boolean; claimable_paths: string[] };
    expect(data.can_claim_all).toBe(true);
    expect(data.claimable_paths).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
  });

  test('vibecode_claims_add_bulk creates claims + intent metadata', async () => {
    build(repo.repoRoot, 'agent-a');
    const result = await buildClaimsAddBulkTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent: 'add alpha feature', paths: ['src/alpha.ts', 'tests/alpha.test.ts'] },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      status: string;
      intent_id: string;
      created_claims: Array<{ path: string }>;
    };
    expect(data.status).toBe('ok');
    expect(data.intent_id).toMatch(/^intent-/);
    expect(data.created_claims.map((c) => c.path)).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
    expect(loadCoordinationState(repo.repoRoot).claims).toHaveLength(2);
  });

  test('extends an existing intent via intent_id', async () => {
    build(repo.repoRoot, 'agent-a');
    const first = await buildClaimsAddBulkTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent: 'add alpha', paths: ['src/alpha.ts'] },
      requestId: null,
    });
    const intentId = (first.structuredContent.data as { intent_id: string }).intent_id;

    const extended = await buildClaimsAddBulkTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent_id: intentId, paths: ['package-lock.json'] },
      requestId: null,
    });
    const data = extended.structuredContent.data as { status: string; intent_id: string; created_claims: Array<{ path: string }> };
    expect(data.status).toBe('ok');
    expect(data.intent_id).toBe(intentId);
    expect(data.created_claims.map((c) => c.path)).toEqual(['package-lock.json']);
  });

  test('conflict returns a structured blocked result and creates no new claims', async () => {
    build(repo.repoRoot, 'agent-a');
    build(repo.repoRoot, 'agent-b');
    addFileClaim(repo.repoRoot, { agent_id: 'agent-b', path: 'src/beta.ts', mode: 'exclusive' }, { claimId: 'claim-b' });
    const before = loadCoordinationState(repo.repoRoot).claims.length;

    const result = await buildClaimsAddBulkTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent: 'add alpha', paths: ['src/alpha.ts', 'src/beta.ts'] },
      requestId: null,
    });

    // Blocked is a structured SUCCESS (not an MCP error), mirroring finalize_check.
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as {
      status: string;
      created_claims: unknown[];
      blocked_paths: Array<{ path: string; reason: string; conflicting_claims: Array<{ claim_id: string }> }>;
      conflict_id: string | null;
    };
    expect(data.status).toBe('blocked');
    expect(data.created_claims).toEqual([]);
    expect(data.blocked_paths[0]).toMatchObject({ path: 'src/beta.ts', reason: 'claimed_by_other_active_agent' });
    expect(data.blocked_paths[0].conflicting_claims[0].claim_id).toBe('claim-b');
    expect(data.conflict_id).toMatch(/^conflict-/);
    expect(loadCoordinationState(repo.repoRoot).claims.length).toBe(before);
  });

  test('read_only agents are blocked from both tools', async () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'ro', agent_type: 'codex', metadata: { operating_mode: 'read_only', task: 'review' } },
      { agentId: 'agent-ro' },
    );
    const plan = await buildClaimsPlanTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-ro', paths: ['a.ts'] },
      requestId: null,
    });
    expect(plan.isError).toBe(true);
    expect(plan.structuredContent.error?.code).toBe('READ_ONLY_AGENT');

    const bulk = await buildClaimsAddBulkTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-ro', intent: 'x', paths: ['a.ts'] },
      requestId: null,
    });
    expect(bulk.isError).toBe(true);
    expect(bulk.structuredContent.error?.code).toBe('READ_ONLY_AGENT');
  });

  test('missing/forbidden intent extension returns structured errors', async () => {
    build(repo.repoRoot, 'agent-a');
    const missing = await buildClaimsAddBulkTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent_id: 'intent-nope', paths: ['a.ts'] },
      requestId: null,
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error?.code).toBe('INTENT_NOT_FOUND');
  });

  test('unknown fields and a repo argument are rejected', async () => {
    build(repo.repoRoot, 'agent-a');
    for (const tool of [buildClaimsPlanTool(), buildClaimsAddBulkTool()]) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('repo');
      const result = await tool.handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: 'agent-a', paths: ['a.ts'], repo: '/elsewhere' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('missing/empty paths are rejected as INVALID_ARGUMENT', async () => {
    build(repo.repoRoot, 'agent-a');
    const result = await buildClaimsAddBulkTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-a', intent: 'x', paths: [] },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('tools call the shared core service and do not shell out to the CLI', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/app/mcp/tools/claims_bulk.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecSync\s*\(/);
    expect(source).toMatch(/core\/coordination\/(claim_planning|bulk_claims)/);
  });
});
