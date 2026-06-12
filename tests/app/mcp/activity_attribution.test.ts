import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  createVibecodeMcpServer,
  resolveMcpToolUsageLogPath,
  type VibecodeMcpServerHandle,
} from '../../../src/app/mcp/index.js';
import {
  getAgentStatus,
  markAgentTerminated,
  registerAgent,
} from '../../../src/core/coordination/agents.js';

/**
 * Activity attribution for VibecodeMCP v1 tool usage events.
 *
 * What breaks if removed:
 *   - usage events could silently lose agent attribution again, making the
 *     desktop observability surface unable to prove which agent used MCP;
 *   - unattributed calls could be fake-attributed (or attributed calls could
 *     stop updating the agent activity timestamp);
 *   - old internal MCP tool names could leak back into the usage log;
 *   - bounded input summaries could regress into raw input/path dumps.
 */

const OLD_NAME_PATTERN = /vibecode_(session_bootstrap|workspace_info|workspace_status|mcp_guidance|current_run|run_get|runs_list|artifacts_list|scan_summary|scan_artifact_read|git_changes|finalize_check|claim_add|claim_release|claim_status|claims_list|claims_plan|claims_add_bulk|claim_intents_list|claim_intent_release|handoff_prepare|handoff_guide|agent_register|agent_heartbeat|agent_status|agents_list|coordination_status|conflicts_list|conflict_detail|conflict_resolve|claims_reap|evidence_list|evidence_scan|tool_profile|team_status|codegraph_context|codegraph_files|codegraph_status|codegraph_usage|codegraph_callees)\b/;

interface ConnectedServer {
  client: Client;
  handle: VibecodeMcpServerHandle;
  close(): Promise<void>;
}

async function connect(repoRoot: string): Promise<ConnectedServer> {
  const handle = createVibecodeMcpServer({ context: { repoRoot }, logLevel: 'silent' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverT);
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  await client.connect(clientT);
  return {
    client,
    handle,
    async close() {
      await client.close();
      await handle.close();
    },
  };
}

function readUsageEvents(repoRoot: string): Array<Record<string, unknown>> {
  const logPath = resolveMcpToolUsageLogPath(repoRoot);
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeRunFixture(repoRoot: string): void {
  const runDir = path.join(repoRoot, '.vibecode', 'runs', 'r1');
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: 'r1', created_at: '2026-06-12T00:00:00Z', task: 't' }),
    'utf8',
  );
}

describe('MCP v1 activity attribution', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-attr-'));
    fs.mkdirSync(path.join(repoRoot, '.codegraph'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('successful v1 call writes a usage event with source mcp', async () => {
    makeRunFixture(repoRoot);
    const server = await connect(repoRoot);
    try {
      await server.client.callTool({ name: 'vibecode_run_status', arguments: { run_ref: 'r1' } });
    } finally {
      await server.close();
    }
    const events = readUsageEvents(repoRoot);
    const event = events.find((e) => e.tool === 'vibecode_run_status');
    expect(event).toBeDefined();
    expect(event?.ok).toBe(true);
    expect(event?.source).toBe('mcp');
    expect(typeof event?.duration_ms).toBe('number');
    expect(typeof event?.timestamp).toBe('string');
  });

  test('failed v1 call writes a usage event with ok=false and an error code', async () => {
    const server = await connect(repoRoot);
    try {
      await server.client.callTool({
        name: 'vibecode_build_start',
        arguments: { agent_id: 'no-such-agent', paths: ['src/x.ts'] },
      });
    } finally {
      await server.close();
    }
    const events = readUsageEvents(repoRoot);
    const event = events.find((e) => e.tool === 'vibecode_build_start');
    expect(event).toBeDefined();
    expect(event?.ok).toBe(false);
    expect((event?.error as { code?: string } | null)?.code).toBe('AGENT_NOT_FOUND');
    // Attribution is what the caller claimed; the failed lookup stays honest in error.
    expect(event?.agent_id).toBe('no-such-agent');
  });

  test('event includes agent_id and agent_mode when tool args carry agent_id', async () => {
    registerAgent(
      repoRoot,
      { agent_name: 'A', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
      { agentId: 'agent-a' },
    );
    const server = await connect(repoRoot);
    try {
      await server.client.callTool({ name: 'vibecode_workspace_snapshot', arguments: { agent_id: 'agent-a' } });
    } finally {
      await server.close();
    }
    const event = readUsageEvents(repoRoot).find((e) => e.tool === 'vibecode_workspace_snapshot');
    expect(event?.agent_id).toBe('agent-a');
    expect(event?.agent_mode).toBe('build');
    expect((event?.input_summary as Record<string, unknown>).has_agent_id).toBe(true);
  });

  test('vibecode_session_start event includes the resolved agent_id', async () => {
    const server = await connect(repoRoot);
    let resolvedAgentId: string | undefined;
    try {
      const result = (await server.client.callTool({
        name: 'vibecode_session_start',
        arguments: { mode: 'read_only', task: 'attribution test' },
      })) as { structuredContent?: { data?: { agent_id?: string } } };
      resolvedAgentId = result.structuredContent?.data?.agent_id;
    } finally {
      await server.close();
    }
    expect(typeof resolvedAgentId).toBe('string');
    const event = readUsageEvents(repoRoot).find((e) => e.tool === 'vibecode_session_start');
    expect(event).toBeDefined();
    expect(event?.agent_id).toBe(resolvedAgentId);
  });

  test('tool calls without agent_id stay unattributed', async () => {
    const server = await connect(repoRoot);
    try {
      await server.client.callTool({ name: 'vibecode_project_instructions', arguments: {} });
    } finally {
      await server.close();
    }
    const event = readUsageEvents(repoRoot).find((e) => e.tool === 'vibecode_project_instructions');
    expect(event).toBeDefined();
    expect(event?.agent_id).toBeUndefined();
    expect(event?.agent_mode).toBeUndefined();
    expect((event?.input_summary as Record<string, unknown>).has_agent_id).toBe(false);
  });

  test('usage events never contain old MCP tool names', async () => {
    const server = await connect(repoRoot);
    try {
      await server.client.callTool({
        name: 'vibecode_session_start',
        arguments: { mode: 'read_only', task: 't' },
      });
      await server.client.callTool({ name: 'vibecode_workspace_snapshot', arguments: {} });
    } finally {
      await server.close();
    }
    const logText = fs.readFileSync(resolveMcpToolUsageLogPath(repoRoot), 'utf8');
    expect(logText).not.toMatch(OLD_NAME_PATTERN);
    const tools = readUsageEvents(repoRoot).map((e) => e.tool);
    expect(tools).toContain('vibecode_session_start');
    expect(tools).toContain('vibecode_workspace_snapshot');
  });

  test('input_summary is bounded: path counts and flags only, never raw paths or contents', async () => {
    registerAgent(
      repoRoot,
      { agent_name: 'A', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
      { agentId: 'agent-a' },
    );
    const server = await connect(repoRoot);
    const sentinelPath = 'src/SENTINEL_SECRET_PATH_DO_NOT_LOG.ts';
    try {
      await server.client.callTool({
        name: 'vibecode_build_start',
        arguments: { agent_id: 'agent-a', paths: [sentinelPath, 'src/other.ts'], dry_run: true },
      });
    } finally {
      await server.close();
    }
    const event = readUsageEvents(repoRoot).find((e) => e.tool === 'vibecode_build_start');
    expect(event).toBeDefined();
    const summary = event?.input_summary as Record<string, unknown>;
    expect(summary.path_count).toBe(2);
    expect(summary.has_intent_id).toBe(false);
    expect(JSON.stringify(summary)).not.toContain(sentinelPath);
    for (const value of Object.values(summary)) {
      expect(['number', 'boolean'].includes(typeof value) || value === 'run' || value === 'scan').toBe(true);
    }
  });

  test('artifact reads record artifact_type without leaking content', async () => {
    makeRunFixture(repoRoot);
    const secret = 'ARTIFACT-CONTENT-MUST-NOT-APPEAR-IN-LOG';
    fs.writeFileSync(path.join(repoRoot, '.vibecode', 'runs', 'r1', 'output', 'final_prompt.md'), secret, 'utf8');
    const server = await connect(repoRoot);
    try {
      await server.client.callTool({
        name: 'vibecode_artifact_read',
        arguments: { run_ref: 'r1', artifact_type: 'run', artifact_key: 'final_prompt' },
      });
    } finally {
      await server.close();
    }
    const logText = fs.readFileSync(resolveMcpToolUsageLogPath(repoRoot), 'utf8');
    expect(logText).not.toContain(secret);
    const event = readUsageEvents(repoRoot).find((e) => e.tool === 'vibecode_artifact_read');
    expect((event?.input_summary as Record<string, unknown>).artifact_type).toBe('run');
  });

  test('a valid attributed call updates the agent activity timestamp', async () => {
    const past = '2026-01-01T00:00:00.000Z';
    registerAgent(
      repoRoot,
      { agent_name: 'A', agent_type: 'custom', metadata: { operating_mode: 'read_only', task: 't' } },
      { agentId: 'agent-a', now: past },
    );
    const server = await connect(repoRoot);
    try {
      await server.client.callTool({ name: 'vibecode_workspace_snapshot', arguments: { agent_id: 'agent-a' } });
    } finally {
      await server.close();
    }
    const agent = getAgentStatus(repoRoot, 'agent-a');
    expect(Date.parse(agent.last_heartbeat_at)).toBeGreaterThan(Date.parse(past));
    expect(agent.status).toBe('active');
  });

  test('a terminated agent is never revived by attributed activity', async () => {
    registerAgent(
      repoRoot,
      { agent_name: 'A', agent_type: 'custom', metadata: { operating_mode: 'read_only', task: 't' } },
      { agentId: 'agent-t' },
    );
    markAgentTerminated(repoRoot, 'agent-t');
    const server = await connect(repoRoot);
    try {
      const result = (await server.client.callTool({
        name: 'vibecode_workspace_snapshot',
        arguments: { agent_id: 'agent-t' },
      })) as { isError?: boolean };
      // Read-only call still succeeds; only the activity update is skipped.
      expect(result.isError ?? false).toBe(false);
    } finally {
      await server.close();
    }
    const agent = getAgentStatus(repoRoot, 'agent-t');
    expect(agent.status).toBe('terminated');
    const event = readUsageEvents(repoRoot).find((e) => e.tool === 'vibecode_workspace_snapshot');
    expect(event?.agent_id).toBe('agent-t');
  });

  test('read-only tools log without requiring claims; build tools keep claim semantics', async () => {
    registerAgent(
      repoRoot,
      { agent_name: 'RO', agent_type: 'custom', metadata: { operating_mode: 'read_only', task: 't' } },
      { agentId: 'agent-ro' },
    );
    const server = await connect(repoRoot);
    try {
      const snapshot = (await server.client.callTool({
        name: 'vibecode_workspace_snapshot',
        arguments: { agent_id: 'agent-ro' },
      })) as { isError?: boolean };
      expect(snapshot.isError ?? false).toBe(false);
      const build = (await server.client.callTool({
        name: 'vibecode_build_start',
        arguments: { agent_id: 'agent-ro', paths: ['src/x.ts'] },
      })) as { isError?: boolean };
      // Phase 1A enforcement is preserved: a read_only agent may not claim.
      expect(build.isError).toBe(true);
    } finally {
      await server.close();
    }
    const events = readUsageEvents(repoRoot);
    const snapshotEvent = events.find((e) => e.tool === 'vibecode_workspace_snapshot');
    const buildEvent = events.find((e) => e.tool === 'vibecode_build_start');
    expect(snapshotEvent?.ok).toBe(true);
    expect(buildEvent?.ok).toBe(false);
    expect((buildEvent?.error as { code?: string } | null)?.code).toBe('READ_ONLY_AGENT');
  });
});
