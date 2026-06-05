import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  runCodeGraphContextQuery,
  runCodeGraphFiles,
  runCodeGraphSearch,
} from '../../../src/adapters/codegraph/codegraph_query_commands.js';
import type {
  CodeGraphActionRunner,
  CodeGraphRunResult,
} from '../../../src/adapters/codegraph/codegraph_actions.js';
import {
  buildCodeGraphContextTool,
} from '../../../src/app/mcp/tools/codegraph_context.js';
import {
  buildCodeGraphFilesTool,
} from '../../../src/app/mcp/tools/codegraph_files.js';
import {
  buildCodeGraphSearchTool,
} from '../../../src/app/mcp/tools/codegraph_search.js';

const FAKE_BINARY = { command: 'codegraph', source: 'PATH_FALLBACK' as const, configured: null };

function fakeRunner(stdout: string): CodeGraphActionRunner {
  return (): CodeGraphRunResult => ({ ok: true, stdout, stderr: '', exitCode: 0 });
}

function makeRepoWithCodegraph(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(repoRoot, '.codegraph'), { recursive: true });
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('CLI / MCP parity for read-only CodeGraph tools', () => {
  test('search: MCP structuredContent.data.parsed_json equals the CLI parsedJson payload', () => {
    const { repoRoot, cleanup } = makeRepoWithCodegraph('vibecode-mcp-parity-search-');
    try {
      const runner = fakeRunner(JSON.stringify([{ score: 1.0, node: { name: 'foo' } }]));
      // CLI-side call path (same core service).
      const cliResult = runCodeGraphSearch({
        repoRoot,
        query: 'foo',
        command: FAKE_BINARY.command,
        binarySource: FAKE_BINARY.source,
        runner,
        json: true,
      });
      expect(cliResult.ok).toBe(true);
      const cliParsed = cliResult.parsedJson as Array<Record<string, unknown>>;

      // MCP-side call path.
      const tool = buildCodeGraphSearchTool({ runner, binary: FAKE_BINARY });
      return tool.handler({ context: { repoRoot }, arguments: { query: 'foo' }, requestId: null }).then((mcpResult) => {
        expect(mcpResult.isError).toBe(false);
        const mcpParsed = (mcpResult.structuredContent.data as { parsed_json: Array<Record<string, unknown>> }).parsed_json;
        expect(mcpParsed).toEqual(cliParsed);
      });
    } finally {
      cleanup();
    }
  });

  test('context: MCP structuredContent text equals the CLI stdoutText payload', async () => {
    const { repoRoot, cleanup } = makeRepoWithCodegraph('vibecode-mcp-parity-context-');
    try {
      const runner = fakeRunner('# context block\n\nbody text');
      const cliResult = runCodeGraphContextQuery({
        repoRoot,
        query: 'fix auth',
        command: FAKE_BINARY.command,
        binarySource: FAKE_BINARY.source,
        runner,
      });
      expect(cliResult.ok).toBe(true);
      const tool = buildCodeGraphContextTool({ runner, binary: FAKE_BINARY });
      const mcpResult = await tool.handler({
        context: { repoRoot },
        arguments: { query: 'fix auth' },
        requestId: null,
      });
      expect(mcpResult.isError).toBe(false);
      const mcpData = mcpResult.structuredContent.data as { stdoutText?: string };
      expect(mcpData.stdoutText).toBe(cliResult.stdoutText);
      // MCP text content carries the same substantive text from upstream.
      expect(mcpResult.content[0].text).toContain('body text');
    } finally {
      cleanup();
    }
  });

  test('files: MCP structuredContent.data.parsed_json equals the CLI parsedJson payload (both honor `limit`)', async () => {
    const { repoRoot, cleanup } = makeRepoWithCodegraph('vibecode-mcp-parity-files-');
    try {
      const runner = fakeRunner(JSON.stringify(['a.ts', 'b.ts', 'c.ts', 'd.ts']));
      const cliResult = runCodeGraphFiles({
        repoRoot,
        command: FAKE_BINARY.command,
        binarySource: FAKE_BINARY.source,
        runner,
        json: true,
        limit: 2,
      });
      expect(cliResult.ok).toBe(true);
      const tool = buildCodeGraphFilesTool({ runner, binary: FAKE_BINARY });
      const mcpResult = await tool.handler({
        context: { repoRoot },
        arguments: { limit: 2 },
        requestId: null,
      });
      expect(mcpResult.isError).toBe(false);
      const cliParsed = cliResult.parsedJson;
      const mcpParsed = (mcpResult.structuredContent.data as { parsed_json: unknown }).parsed_json;
      expect(mcpParsed).toEqual(cliParsed);
    } finally {
      cleanup();
    }
  });

  test('warning surfacing: CLI warnings are mirrored in MCP structuredContent.warnings', async () => {
    const { repoRoot, cleanup } = makeRepoWithCodegraph('vibecode-mcp-parity-warn-');
    try {
      const runner: CodeGraphActionRunner = () => ({
        ok: true,
        stdout: JSON.stringify(['a.ts', 'b.ts', 'c.ts']),
        stderr: '',
        exitCode: 0,
      });
      const tool = buildCodeGraphFilesTool({ runner, binary: FAKE_BINARY });
      const mcpResult = await tool.handler({
        context: { repoRoot },
        arguments: { limit: 2 },
        requestId: null,
      });
      // The files runner emits CODEGRAPH_FILES_TRUNCATED when capping.
      expect(mcpResult.structuredContent.warnings.some((w) => w.startsWith('CODEGRAPH_FILES_TRUNCATED'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
