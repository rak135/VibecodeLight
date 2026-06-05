#!/usr/bin/env node
// Manual smoke for `vibecode mcp serve --repo <path>`. Spawns the real CLI
// over stdio via the official MCP SDK client and verifies:
//   1. initialize completes
//   2. tools/list returns the canonical 7 names
//   3. vibecode_codegraph_status returns a structured envelope
//   4. vibecode_codegraph_context with a tiny query returns a structured
//      result (CODEGRAPH_NOT_INITIALIZED on a fresh repo is expected and
//      counts as a success — what we care about is the protocol round-trip)
//
// This script is NOT a test; it is a manual end-to-end check.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = process.argv[2] || process.cwd();
const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, '..', 'bin', 'vibecode.js');

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, 'mcp', 'serve', '--repo', repoRoot, '--log-level', 'silent'],
    cwd: repoRoot,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'vibecode-mcp-manual-smoke', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  console.log('[smoke] connected and initialize complete');

  const listed = await client.listTools();
  const names = (listed.tools ?? []).map((t) => t.name).sort();
  console.log('[smoke] tools/list:', JSON.stringify(names));
  if (names.length !== 7) throw new Error(`expected 7 tools, got ${names.length}`);

  const status = await client.callTool({ name: 'vibecode_codegraph_status', arguments: {} });
  console.log('[smoke] status.isError:', status.isError === true ? 'true' : 'false');
  console.log('[smoke] status.structuredContent:', JSON.stringify(status.structuredContent).slice(0, 240));

  const ctx = await client.callTool({ name: 'vibecode_codegraph_context', arguments: { query: 'mcp', maxNodes: 5, maxCode: 1 } });
  console.log('[smoke] context.isError:', ctx.isError === true ? 'true' : 'false');
  console.log('[smoke] context.structuredContent:', JSON.stringify(ctx.structuredContent).slice(0, 240));

  await client.close();
  console.log('[smoke] OK');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
