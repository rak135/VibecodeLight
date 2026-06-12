import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildHandoffPrepareTool } from '../../../src/app/mcp/tools/handoff_prepare.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';
import type { AgentHandoffPacket } from '../../../src/core/agent_session/handoff_packet.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';

/**
 * Phase 4A — `vibecode_handoff_prepare` MCP tool contract.
 *
 * What breaks if removed:
 *   - the tool could accept unknown/unbounded input or a missing agent_id;
 *   - terminated/missing agents could become tool errors (or worse, mutations)
 *     instead of a safe handoff state inside the packet;
 *   - the canonical envelope or the registry registration could drift from the
 *     CLI parity surface.
 */

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  git(['config', 'core.autocrlf', 'false'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function write(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function registerBuildAgent(repoRoot: string): string {
  return registerAgent(repoRoot, {
    agent_name: 'A',
    agent_type: 'claude',
    metadata: { operating_mode: 'build', task: 'phase 4a test' },
  }).agent_id;
}

describe('VibecodeMCP handoff_prepare tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-handoff-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('is registered in the canonical tool name list', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).not.toContain('vibecode_handoff_prepare');
    expect(buildHandoffPrepareTool().name).toBe('vibecode_handoff_prepare');
  });

  test('input schema is additionalProperties=false, agent_id required', () => {
    const schema = buildHandoffPrepareTool().inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['agent_id', 'max_items']);
    expect(schema.required).toEqual(['agent_id']);
  });

  test('rejects an unknown field with INVALID_ARGUMENT', async () => {
    const result = await buildHandoffPrepareTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'a', repo: '/etc/passwd' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('rejects a missing/empty agent_id with INVALID_ARGUMENT', async () => {
    for (const args of [{}, { agent_id: '' }, { agent_id: '   ' }]) {
      const result = await buildHandoffPrepareTool().handler({
        context: ctx(repo.repoRoot),
        arguments: args,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('rejects invalid and over-cap max_items with INVALID_ARGUMENT', async () => {
    for (const maxItems of [0, -1, 1.5, 'ten', 51]) {
      const result = await buildHandoffPrepareTool().handler({
        context: ctx(repo.repoRoot),
        arguments: { agent_id: 'agent-x', max_items: maxItems },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('returns a canonical ok envelope with the packet for an active agent', async () => {
    const agentId = registerBuildAgent(repo.repoRoot);
    const result = await buildHandoffPrepareTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agentId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.tool).toBe('vibecode_handoff_prepare');
    const data = result.structuredContent.data as AgentHandoffPacket;
    expect(data.agent_id).toBe(agentId);
    expect(data.handoff.handoff_state).toBe('ready_to_handoff');
    expect(data.handoff.handoff_ready).toBe(true);
    expect(data.do_not_do.length).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('Handoff:');
  });

  test('dirty claimed file: commit_before_handoff in the packet, no mutation', async () => {
    const agentId = registerBuildAgent(repo.repoRoot);
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: agentId, intent: 'work', paths: ['src/mine.ts'] });
    write(repo.repoRoot, 'src/mine.ts');

    const before = git(['status', '--porcelain'], repo.repoRoot).stdout;
    const result = await buildHandoffPrepareTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agentId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as AgentHandoffPacket;
    expect(data.handoff.handoff_state).toBe('commit_before_handoff');
    expect(data.handoff.handoff_ready).toBe(false);
    // Strictly read-only: the working tree is untouched.
    const after = git(['status', '--porcelain'], repo.repoRoot).stdout;
    expect(after).toBe(before);
  });

  test('terminated agent returns a handoff state in an ok envelope, not an error or mutation', async () => {
    const agentId = registerBuildAgent(repo.repoRoot);
    markAgentTerminated(repo.repoRoot, agentId);

    const result = await buildHandoffPrepareTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agentId },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as AgentHandoffPacket;
    expect(data.handoff.handoff_state).toBe('terminated_or_missing_agent');
    expect(data.blockers.some((b) => b.code === 'AGENT_TERMINATED')).toBe(true);
  });

  test('missing agent is handled safely as terminated_or_missing_agent', async () => {
    const result = await buildHandoffPrepareTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-never-existed' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as AgentHandoffPacket;
    expect(data.handoff.handoff_state).toBe('terminated_or_missing_agent');
    expect(data.blockers.some((b) => b.code === 'AGENT_NOT_FOUND')).toBe(true);
  });

  test('prepare never heartbeats: the agent stays untouched in coordination state', async () => {
    const agentId = registerBuildAgent(repo.repoRoot);
    const statePath = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const before = fs.readFileSync(statePath, 'utf8');
    await buildHandoffPrepareTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agentId },
      requestId: null,
    });
    const after = fs.readFileSync(statePath, 'utf8');
    expect(after).toBe(before);
  });
});
