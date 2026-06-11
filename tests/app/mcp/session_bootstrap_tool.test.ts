import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildSessionBootstrapTool } from '../../../src/app/mcp/tools/session_bootstrap.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import { registerAgent, markAgentTerminated, listAgents } from '../../../src/core/coordination/agents.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';
import type { SessionBootstrapResult } from '../../../src/core/agent_session/bootstrap.js';

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

// Stub CodeGraph so the tool never spawns the upstream binary in tests.
const tool = () => buildSessionBootstrapTool({ codegraphStatus: async () => ({ available: false, initialized: false, version: null }) });

describe('VibecodeMCP session_bootstrap tool', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-bootstrap-mcp-');
  });
  afterEach(() => repo.cleanup());

  test('is registered in the canonical tool name list', () => {
    expect(VIBECODE_MCP_TOOL_NAMES).toContain('vibecode_session_bootstrap');
    expect(buildSessionBootstrapTool().name).toBe('vibecode_session_bootstrap');
  });

  test('input schema is additionalProperties=false and accepts no repo key', () => {
    const schema = buildSessionBootstrapTool().inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).not.toContain('repo');
  });

  test('rejects an unknown field with INVALID_ARGUMENT', async () => {
    const result = await tool().handler({ context: ctx(repo.repoRoot), arguments: { bogus: 1 }, requestId: null });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('returns expected structuredContent with protocol + recommendations', async () => {
    const result = await tool().handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
    const data = result.structuredContent.data as SessionBootstrapResult;
    expect(data.repo_root).toBe(repo.repoRoot);
    expect(data.agent_protocol.length).toBeGreaterThan(0);
    expect(data.recommended_next_tools).toContain('vibecode_git_changes');
    expect(data.codegraph).toMatchObject({ available: false, initialized: false });
  });

  test('includes compact server_identity so agents can detect a stale MCP server', async () => {
    const result = await tool().handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as SessionBootstrapResult & {
      server_identity: {
        server_name: string;
        server_version: string;
        tool_count: number;
        started_at: string;
        repo_root: string;
      };
    };
    expect(Object.keys(data.server_identity).sort()).toEqual([
      'repo_root',
      'server_name',
      'server_version',
      'started_at',
      'tool_count',
    ]);
    expect(data.server_identity.server_name).toBe('vibecode-mcp');
    // Tool count comes from the canonical registry of THIS running build.
    expect(data.server_identity.tool_count).toBe(VIBECODE_MCP_TOOL_NAMES.length);
    expect(Number.isNaN(Date.parse(data.server_identity.started_at))).toBe(false);
    expect(data.server_identity.repo_root).toBe(repo.repoRoot);
  });

  test('includes a compact stale_coordination summary (Phase 2C)', async () => {
    // Clean repo: compact, no stale state, no housekeeping recommendation.
    const clean = await tool().handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    const cleanData = clean.structuredContent.data as SessionBootstrapResult;
    expect(cleanData.stale_coordination.has_stale_state).toBe(false);
    expect(cleanData.stale_coordination.recommended_cli_commands).toEqual([]);

    // Seed an agent whose heartbeat is far in the past (stale by TTL).
    registerAgent(
      repo.repoRoot,
      { agent_name: 'Old', agent_type: 'opencode', metadata: { operating_mode: 'build', task: 'old work' } },
      { agentId: 'agent-old', now: '2020-01-01T00:00:00.000Z' },
    );

    const result = await tool().handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as SessionBootstrapResult;
    expect(data.stale_coordination.has_stale_state).toBe(true);
    expect(data.stale_coordination.stale_agents_count).toBe(1);
    expect(data.stale_coordination.samples.stale_agents[0].agent_id).toBe('agent-old');
    expect(data.stale_coordination.recommended_cli_commands).toContain('vibecode claims reap --dry-run --json');
    expect(data.recommended_tool_profiles.map((p) => p.profile_id)).toContain('coordination_housekeeping');
    expect(data.warnings.some((w) => w.code === 'STALE_COORDINATION_STATE')).toBe(true);
  });

  test('runtime_awareness is present and the MCP adapter fills its server section (Phase 3B)', async () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'Me', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'phase 3b' } },
      { agentId: 'agent-me' },
    );
    const result = await tool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: 'agent-me' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as SessionBootstrapResult & {
      server_identity: { tool_count: number; started_at: string };
    };
    const ra = data.runtime_awareness;
    expect(ra.agent.agent_id).toBe('agent-me');
    expect(ra.agent.status).toBe('active');
    // The MCP layer fills the live server identity (core leaves it null) so an
    // agent can detect a stale MCP server session from the preflight alone.
    expect(ra.server).not.toBeNull();
    expect(ra.server?.server_name).toBe('vibecode-mcp');
    expect(ra.server?.tool_count).toBe(VIBECODE_MCP_TOOL_NAMES.length);
    // The preflight server section and the top-level server_identity agree.
    expect(ra.server?.tool_count).toBe(data.server_identity.tool_count);
    expect(ra.server?.started_at).toBe(data.server_identity.started_at);
  });

  test('register=true writes only generated coordination state and returns identity', async () => {
    const result = await tool().handler({
      context: ctx(repo.repoRoot),
      arguments: { register: true, agent_mode: 'build', task: 'do work', agent_type: 'claude' },
      requestId: null,
    });
    expect(result.isError).toBe(false);
    const data = result.structuredContent.data as SessionBootstrapResult;
    expect(data.generated_state_written).toBe(true);
    expect(data.current_agent?.operating_mode).toBe('build');
    expect(listAgents(repo.repoRoot)).toHaveLength(1);
  });

  test('register=true with invalid agent_mode is an INVALID_ARGUMENT error', async () => {
    const result = await tool().handler({
      context: ctx(repo.repoRoot),
      arguments: { register: true, agent_mode: 'nope', task: 'x' },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('terminated agent_id is an AGENT_TERMINATED error', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    markAgentTerminated(repo.repoRoot, agent.agent_id);
    const result = await tool().handler({
      context: ctx(repo.repoRoot),
      arguments: { agent_id: agent.agent_id },
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('AGENT_TERMINATED');
  });
});
