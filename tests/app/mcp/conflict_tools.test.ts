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
  buildConflictDetailTool,
} from '../../../src/app/mcp/tools/conflicts.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
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

describe('VibecodeMCP conflict detail tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-conflict-detail-mcp-');
  });

  afterEach(() => repo.cleanup());

  test('vibecode_conflict_detail returns triage detail for active blocking conflict', async () => {
    const now = new Date().toISOString();
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } },
      { now, agentId: 'agent-a' },
    );
    registerAgent(
      repo.repoRoot,
      { agent_name: 'B', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } },
      { now, agentId: 'agent-b' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' },
      { now, claimId: 'claim-1' },
    );
    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: now,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now });

    const tool = buildConflictDetailTool();
    expect(tool.name).toBe('vibecode_conflict_detail');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { conflict_id: 'conflict-1' },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { conflict: { conflict_id: string; triage_status: string; blocking_agent_id: string; warning_codes: string[] } };
    expect(data.conflict.conflict_id).toBe('conflict-1');
    expect(data.conflict.triage_status).toBe('still_blocking');
    expect(data.conflict.blocking_agent_id).toBe('agent-a');
    expect(data.conflict.warning_codes).toContain('CONFLICT_STILL_BLOCKING');
  });

  test('vibecode_conflict_detail returns error for missing conflict_id', async () => {
    const result = await buildConflictDetailTool().handler({
      context: ctx(repo.repoRoot),
      arguments: {},
      requestId: null,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('vibecode_conflict_detail returns error for unknown conflict id', async () => {
    const result = await buildConflictDetailTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { conflict_id: 'nonexistent' },
      requestId: null,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('conflict detail tool does not accept a repo argument', async () => {
    const tool = buildConflictDetailTool();
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('repo');
  });

  test('vibecode_conflict_detail includes blocking intent when available', async () => {
    const now = new Date().toISOString();
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } },
      { now, agentId: 'agent-a' },
    );
    registerAgent(
      repo.repoRoot,
      { agent_name: 'B', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } },
      { now, agentId: 'agent-b' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' },
      { now, claimId: 'claim-1' },
    );

    // Record intent directly in state.
    const fs = await import('fs');
    const stateFile = require('path').join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.intents.push({
      intent_id: 'intent-1',
      agent_id: 'agent-a',
      intent: 'implement feature X',
      status: 'active',
      created_at: now,
      updated_at: now,
      claim_ids: ['claim-1'],
      paths: ['src/app.ts'],
    });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: now,
      involved_claims: ['claim-1'],
      involved_agents: ['agent-b', 'agent-a'],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1', now });

    const result = await buildConflictDetailTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { conflict_id: 'conflict-1' },
      requestId: null,
    });

    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as { conflict: { blocking_intent: { intent_id: string; intent: string; status: string } | null } };
    expect(data.conflict.blocking_intent).not.toBeNull();
    expect(data.conflict.blocking_intent!.intent_id).toBe('intent-1');
    expect(data.conflict.blocking_intent!.intent).toBe('implement feature X');
  });
});
