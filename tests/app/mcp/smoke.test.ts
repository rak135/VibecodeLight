import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createVibecodeMcpServer,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';

function makeRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function connectClient(repoRoot: string) {
  const handle = createVibecodeMcpServer({
    context: { repoRoot },
    logLevel: 'silent',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverTransport);
  const client = new Client(
    { name: 'vibecode-mcp-smoke', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { handle, client };
}

describe('VibecodeMCP stdio server smoke (over in-memory transport)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo('vibecode-mcp-smoke-');
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('server connects, initialize completes, and tools/list returns the canonical 29 tools', async () => {
    const { handle, client } = await connectClient(repoRoot);
    try {
      const listed = await client.listTools();
      const names = (listed.tools ?? []).map((t) => t.name);
      expect(names.sort()).toEqual([...VIBECODE_MCP_TOOL_NAMES].sort());
      expect(names.length).toBe(29);
      // Phase MCP-2 additions visible alongside Phase MCP-1.
      expect(names).toContain('vibecode_runs_list');
      expect(names).toContain('vibecode_current_run');
      expect(names).toContain('vibecode_run_get');
      expect(names).toContain('vibecode_artifact_read');
      expect(names).toContain('vibecode_codegraph_usage');
      // Phase MCP-3 workspace orientation tools.
      expect(names).toContain('vibecode_workspace_info');
      expect(names).toContain('vibecode_workspace_status');
      expect(names).toContain('vibecode_mcp_guidance');
      expect(names).toContain('vibecode_project_instructions');
      expect(names).toContain('vibecode_artifacts_list');
      // Phase Coordination-1 tool.
      expect(names).toContain('vibecode_coordination_status');
      // Phase Coordination-2 agent session tools.
      expect(names).toContain('vibecode_agent_register');
      expect(names).toContain('vibecode_agent_heartbeat');
      expect(names).toContain('vibecode_agents_list');
      expect(names).toContain('vibecode_agent_status');
      // Phase Coordination-3A advisory claim tools.
      expect(names).toContain('vibecode_claim_add');
      expect(names).toContain('vibecode_claims_list');
      expect(names).toContain('vibecode_claim_status');
      expect(names).toContain('vibecode_claim_release');
      // Phase Coordination-4A finalize check tool.
      expect(names).toContain('vibecode_finalize_check');
      // Phase Coordination-4C watcher evidence tools.
      expect(names).toContain('vibecode_evidence_list');
      expect(names).toContain('vibecode_evidence_scan');
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test('every tool exposes inputSchema as an object with additionalProperties=false', async () => {
    const { handle, client } = await connectClient(repoRoot);
    try {
      const listed = await client.listTools();
      const tools = listed.tools ?? [];
      expect(tools.length).toBe(29);
      for (const tool of tools) {
        const schema = tool.inputSchema as { type?: string; additionalProperties?: boolean };
        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).toBe(false);
      }
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test('no tool input schema contains a "repo" property — the server is repo-bound', async () => {
    const { handle, client } = await connectClient(repoRoot);
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools ?? []) {
        const schema = tool.inputSchema as { properties?: Record<string, unknown> };
        const keys = Object.keys(schema.properties ?? {});
        expect(keys).not.toContain('repo');
        expect(keys).not.toContain('repoRoot');
        expect(keys).not.toContain('repo_path');
      }
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test('the server advertises the tools capability in initialize', async () => {
    const { handle, client } = await connectClient(repoRoot);
    try {
      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps?.tools).toBeDefined();
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test('calling an unknown tool returns isError=true with UNSUPPORTED_TOOL', async () => {
    const { handle, client } = await connectClient(repoRoot);
    try {
      const result = (await client.callTool({
        name: 'definitely_not_a_tool',
        arguments: {},
      })) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error?.code).toBe('UNSUPPORTED_TOOL');
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
