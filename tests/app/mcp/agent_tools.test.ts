import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildAgentRegisterTool,
  buildAgentHeartbeatTool,
  buildAgentsListTool,
  buildAgentStatusTool,
} from '../../../src/app/mcp/tools/agents.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('VibecodeMCP agent tools', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-agents-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('vibecode_agent_register returns the same core data as the CLI/core path', async () => {
    const tool = buildAgentRegisterTool();
    expect(tool.name).toBe('vibecode_agent_register');

    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { name: 'Codex A', type: 'codex' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const agent = (result.structuredContent.data as { agent: Record<string, unknown> }).agent;
    expect(agent.agent_name).toBe('Codex A');
    expect(agent.agent_type).toBe('codex');
    expect(agent.status).toBe('active');
    expect(typeof agent.agent_id).toBe('string');

    // Repo-bound write went to generated coordination state only.
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(true);
  });

  test('vibecode_agents_list returns the registered agents (parity with core)', async () => {
    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' });

    const tool = buildAgentsListTool();
    const result = await tool.handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);
    const agents = (result.structuredContent.data as { agents: Array<{ agent_name: string }> }).agents;
    expect(agents.map((a) => a.agent_name).sort()).toEqual(['A', 'B']);
  });

  test('vibecode_agent_heartbeat updates the heartbeat', async () => {
    const session = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const tool = buildAgentHeartbeatTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: session.agent_id },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const agent = (result.structuredContent.data as { agent: { agent_id: string; status: string } }).agent;
    expect(agent.agent_id).toBe(session.agent_id);
    expect(agent.status).toBe('active');
  });

  test('vibecode_agent_status returns exactly one agent', async () => {
    const session = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const tool = buildAgentStatusTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: session.agent_id },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const agent = (result.structuredContent.data as { agent: { agent_id: string } }).agent;
    expect(agent.agent_id).toBe(session.agent_id);
  });

  test('an invalid agent type is rejected with INVALID_ARGUMENT', async () => {
    const tool = buildAgentRegisterTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { name: 'X', type: 'gpt' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('a heartbeat for an unknown agent returns AGENT_NOT_FOUND', async () => {
    const tool = buildAgentHeartbeatTool();
    const result = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'nope' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('AGENT_NOT_FOUND');
  });

  test('agent tools do not accept a repo path argument (additionalProperties=false)', async () => {
    for (const tool of [buildAgentRegisterTool(), buildAgentsListTool(), buildAgentStatusTool(), buildAgentHeartbeatTool()]) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('repo');
    }
    const result = await buildAgentsListTool().handler({
      context: ctx(repo.repoRoot),
      arguments: { repo: '/some/other/repo' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('agent tools call the shared core service and do not shell out to the CLI', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/app/mcp/tools/agents.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bexeca\s*\(/);
    expect(source).toMatch(/core\/coordination\/agents/);
  });
});
