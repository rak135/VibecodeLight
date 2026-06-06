import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  buildVibecodeMcpTools,
  createVibecodeMcpServer,
  VIBECODE_MCP_TOOL_NAMES,
} from '../../../src/app/mcp/index.js';

const FORBIDDEN_TOOL_NAME_PATTERNS = [
  /shell/i,
  /exec/i,
  /run_command/i,
  /commit/i,
  /git/i,
  /terminal/i,
];

// Tools that are intentionally read-only despite their names containing
// substrings the forbidden patterns might match. Both vibecode_codegraph_files
// (a list/files-tool) and vibecode_artifact_read (a read-only artifact reader)
// are read-only — neither writes anything.
const ALLOWED_READ_TOOL_NAMES = new Set([
  'vibecode_codegraph_files',
  'vibecode_artifact_read',
]);

const READ_ONLY_NAME_RE = /(write|create|update|delete|put|post|set|edit|modify)/i;

describe('VibecodeMCP security boundary', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-sec-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('no write/shell/git/terminal tool is registered', () => {
    const tools = buildVibecodeMcpTools();
    expect(tools.length).toBe(18);
    for (const tool of tools) {
      if (ALLOWED_READ_TOOL_NAMES.has(tool.name)) continue;
      for (const pattern of FORBIDDEN_TOOL_NAME_PATTERNS) {
        expect(tool.name).not.toMatch(pattern);
      }
      expect(tool.name).not.toMatch(READ_ONLY_NAME_RE);
    }
  });

  test('every tool input schema is additionalProperties=false and never accepts a "repo" key', () => {
    const tools = buildVibecodeMcpTools();
    for (const tool of tools) {
      const schema = tool.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      const props = schema.properties ?? {};
      for (const key of Object.keys(props)) {
        expect(['repo', 'repoRoot', 'repo_path', 'repoPath', 'workspace']).not.toContain(key);
      }
    }
  });

  test('over MCP, a tool call that passes a stray "repo" key is rejected with INVALID_ARGUMENT', async () => {
    const handle = createVibecodeMcpServer({ context: { repoRoot }, logLevel: 'silent' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.connect(serverTransport);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: 'vibecode_codegraph_status',
        arguments: { repo: '/etc/passwd' },
      })) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test('VIBECODE_MCP_TOOL_NAMES matches the registered tool definitions', () => {
    const tools = buildVibecodeMcpTools().map((t) => t.name).sort();
    expect(tools).toEqual([...VIBECODE_MCP_TOOL_NAMES].sort());
  });

  test('secret-looking env values never appear in any tool response (status path)', async () => {
    const handle = createVibecodeMcpServer({ context: { repoRoot }, logLevel: 'silent' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.connect(serverTransport);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(clientTransport);
    const secret = 'sk-thisShouldNeverLeakIntoResponses';
    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = secret;
    try {
      const result = (await client.callTool({
        name: 'vibecode_codegraph_status',
        arguments: {},
      })) as { content?: Array<{ text?: string }>; structuredContent?: unknown };
      const blob = JSON.stringify(result);
      expect(blob).not.toContain(secret);
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
      await client.close();
      await handle.close();
    }
  });

  test('tools/list does not advertise any tool with destructive annotations', async () => {
    const handle = createVibecodeMcpServer({ context: { repoRoot }, logLevel: 'silent' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.connect(serverTransport);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools ?? []) {
        const ann = (tool as unknown as { annotations?: { destructiveHint?: boolean } }).annotations;
        if (ann) expect(ann.destructiveHint).not.toBe(true);
      }
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
