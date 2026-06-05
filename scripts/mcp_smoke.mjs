#!/usr/bin/env node
// Manual smoke for `vibecode mcp serve --repo <path>`. Spawns the real CLI
// over stdio via the official MCP SDK client and verifies:
//   1. initialize completes
//   2. tools/list returns the canonical 12 names (7 MCP-1 + 5 MCP-2)
//   3. vibecode_codegraph_status returns a structured envelope
//   4. vibecode_codegraph_context with a tiny query returns a structured
//      result (CODEGRAPH_NOT_INITIALIZED on a fresh repo is expected and
//      counts as a success — what we care about is the protocol round-trip)
//   5. vibecode_runs_list returns an envelope (possibly empty)
//   6. vibecode_current_run returns either ok=true or RUN_NOT_FOUND
//   7. vibecode_codegraph_usage default-to-latest returns either ok or a
//      structured RUN_NOT_FOUND / ARTIFACT_NOT_FOUND
//
// This script is NOT a test; it is a manual end-to-end check.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = process.argv[2] || process.cwd();
const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, '..', 'bin', 'vibecode.js');

const EXPECTED_TOOLS = [
  'vibecode_codegraph_status',
  'vibecode_codegraph_search',
  'vibecode_codegraph_context',
  'vibecode_codegraph_files',
  'vibecode_codegraph_callers',
  'vibecode_codegraph_callees',
  'vibecode_codegraph_impact',
  'vibecode_runs_list',
  'vibecode_current_run',
  'vibecode_run_get',
  'vibecode_artifact_read',
  'vibecode_codegraph_usage',
].sort();

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
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(`tools/list mismatch.\n  expected: ${JSON.stringify(EXPECTED_TOOLS)}\n  got:      ${JSON.stringify(names)}`);
  }

  // --- MCP-1 read-only CodeGraph round-trip ---
  const status = await client.callTool({ name: 'vibecode_codegraph_status', arguments: {} });
  console.log('[smoke] status.isError:', status.isError === true ? 'true' : 'false');
  console.log('[smoke] status.structuredContent:', JSON.stringify(status.structuredContent).slice(0, 240));

  const ctx = await client.callTool({ name: 'vibecode_codegraph_context', arguments: { query: 'mcp', maxNodes: 5, maxCode: 1 } });
  console.log('[smoke] context.isError:', ctx.isError === true ? 'true' : 'false');
  console.log('[smoke] context.structuredContent:', JSON.stringify(ctx.structuredContent).slice(0, 240));

  // --- MCP-2 read-only run/artifact round-trip ---
  const runs = await client.callTool({ name: 'vibecode_runs_list', arguments: { limit: 3 } });
  console.log('[smoke] runs_list.isError:', runs.isError === true ? 'true' : 'false');
  const runsData = runs.structuredContent?.data;
  console.log('[smoke] runs_list.total:', runsData?.total, 'returned:', runsData?.returned);

  const current = await client.callTool({ name: 'vibecode_current_run', arguments: {} });
  console.log(
    '[smoke] current_run.isError:', current.isError === true ? 'true' : 'false',
    'error.code:', current.structuredContent?.error?.code ?? '(none)',
  );
  if (!current.isError) {
    console.log('[smoke] current_run.data:', JSON.stringify(current.structuredContent.data).slice(0, 240));
  }

  const cgUsage = await client.callTool({ name: 'vibecode_codegraph_usage', arguments: {} });
  console.log(
    '[smoke] codegraph_usage.isError:', cgUsage.isError === true ? 'true' : 'false',
    'error.code:', cgUsage.structuredContent?.error?.code ?? '(none)',
  );

  // Best-effort artifact_read on the latest run if one exists.
  if (!current.isError && current.structuredContent?.data?.run_id) {
    const runId = current.structuredContent.data.run_id;
    const art = await client.callTool({
      name: 'vibecode_artifact_read',
      arguments: { run_id: runId, artifact: 'final_prompt', max_bytes: 256 },
    });
    console.log(
      '[smoke] artifact_read(final_prompt).isError:', art.isError === true ? 'true' : 'false',
      'error.code:', art.structuredContent?.error?.code ?? '(none)',
    );
    if (!art.isError) {
      console.log('[smoke] artifact_read.bytes_read:', art.structuredContent.data?.bytes_read,
                  'truncated:', art.structuredContent.data?.truncated);
    }
  }

  await client.close();
  console.log('[smoke] OK');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
