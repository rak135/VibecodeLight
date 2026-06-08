import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaimsReapTool,
} from '../../../src/app/mcp/tools/claims.js';
import {
  buildConflictsListTool,
  buildConflictResolveTool,
} from '../../../src/app/mcp/tools/conflicts.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { recordConflict } from '../../../src/core/coordination/conflicts.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('VibecodeMCP claims reap tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-reap-mcp-');
  });

  afterEach(() => repo.cleanup());

  test('vibecode_claims_reap releases stale agent claims', async () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const tool = buildClaimsReapTool();
    expect(tool.name).toBe('vibecode_claims_reap');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: {},
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { reaped_claims: unknown[] };
    expect(data.reaped_claims).toHaveLength(1);
  });

  test('vibecode_claims_reap with dry_run does not release', async () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const result = await buildClaimsReapTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { dry_run: true },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { mode: string; reaped_claims: unknown[]; stale_claims: unknown[] };
    expect(data.mode).toBe('dry_run');
    expect(data.stale_claims).toHaveLength(1);
    expect(data.reaped_claims).toHaveLength(0);
  });

  test('claims reap tool does not accept a repo argument', async () => {
    const tool = buildClaimsReapTool();
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('repo');
  });
});

describe('VibecodeMCP conflict tools', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-conflicts-mcp-');
  });

  afterEach(() => repo.cleanup());

  test('vibecode_conflicts_list returns recorded conflicts', async () => {
    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    const result = await buildConflictsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: {},
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { conflicts: Array<{ conflict_id: string }> };
    expect(data.conflicts).toHaveLength(1);
    expect(data.conflicts[0].conflict_id).toBe('conflict-1');
  });

  test('vibecode_conflict_resolve marks conflict as resolved', async () => {
    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: ['agent-1'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    const result = await buildConflictResolveTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { conflict_id: 'conflict-1' },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { conflict: { status: string } };
    expect(data.conflict.status).toBe('resolved');
  });

  test('conflict tools do not accept a repo argument', async () => {
    for (const tool of [buildConflictsListTool(), buildConflictResolveTool()]) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('repo');
    }
  });

  test('conflict resolve returns error for unknown conflict id', async () => {
    const result = await buildConflictResolveTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { conflict_id: 'nonexistent' },
      requestId: null,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('CONFLICT_RESOLVE_FAILED');
  });
});
