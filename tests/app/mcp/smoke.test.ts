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

  test('server connects, initialize completes, and tools/list returns the canonical tool set', async () => {
    const { handle, client } = await connectClient(repoRoot);
    try {
      const listed = await client.listTools();
      const names = (listed.tools ?? []).map((t) => t.name);
      expect([...names].sort()).toEqual([...VIBECODE_MCP_TOOL_NAMES].sort());
      expect(names).toEqual([...VIBECODE_MCP_TOOL_NAMES]);
      expect(names).toHaveLength(14);
      expect(names).toContain('vibecode_session_start');
      expect(names).toContain('vibecode_workspace_snapshot');
      expect(names).toContain('vibecode_build_start');
      expect(names).toContain('vibecode_handoff');
      expect(names).not.toContain('vibecode_session_bootstrap');
      expect(names).not.toContain('vibecode_agent_heartbeat');
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
      expect(tools.length).toBe(VIBECODE_MCP_TOOL_NAMES.length);
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
