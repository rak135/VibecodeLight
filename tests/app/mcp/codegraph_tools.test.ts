import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCodeGraphContextTool,
  type CodeGraphContextToolDeps,
} from '../../../src/app/mcp/tools/codegraph_context.js';
import {
  buildCodeGraphFilesTool,
  type CodeGraphFilesToolDeps,
} from '../../../src/app/mcp/tools/codegraph_files.js';
import {
  buildCodeGraphSearchTool,
  type CodeGraphSearchToolDeps,
} from '../../../src/app/mcp/tools/codegraph_search.js';
import {
  buildCodeGraphStatusTool,
  type CodeGraphStatusToolDeps,
} from '../../../src/app/mcp/tools/codegraph_status.js';
import {
  buildCodeGraphCallersTool,
  buildCodeGraphCalleesTool,
  buildCodeGraphImpactTool,
  type CodeGraphSymbolToolDeps,
} from '../../../src/app/mcp/tools/codegraph_symbol.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';
import type { CodeGraphActionRunner, CodeGraphRunResult } from '../../../src/adapters/codegraph/codegraph_actions.js';

const FAKE_BINARY = {
  command: 'codegraph',
  source: 'PATH_FALLBACK' as const,
  configured: null,
};

function fakeRunner(stdout: string, opts: { ok?: boolean; stderr?: string } = {}): CodeGraphActionRunner {
  return (): CodeGraphRunResult => ({ ok: opts.ok ?? true, stdout, stderr: opts.stderr ?? '', exitCode: opts.ok === false ? 1 : 0 });
}

function makeContext(): { context: McpServerContext; repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-tools-'));
  // Pre-create .codegraph so the query commands' isInitialized check passes
  // without requiring a version probe to find a real binary.
  fs.mkdirSync(path.join(repoRoot, '.codegraph'), { recursive: true });
  return {
    context: { repoRoot },
    repoRoot,
    cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }),
  };
}

describe('vibecode_codegraph_status', () => {
  test('returns structured availability/initialization data from injected runner', async () => {
    const { context, cleanup } = makeContext();
    try {
      const deps: CodeGraphStatusToolDeps = {
        runner: fakeRunner(''),
        binary: FAKE_BINARY,
      };
      const tool = buildCodeGraphStatusTool(deps);
      const result = await tool.handler({ context, arguments: {}, requestId: 'r1' });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.tool).toBe('vibecode_codegraph_status');
      expect(result.structuredContent.repo_root).toBe(context.repoRoot);
      const data = result.structuredContent.data as { initialized: boolean; available: boolean };
      expect(data.initialized).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('rejects an unknown argument with INVALID_ARGUMENT', async () => {
    const { context, cleanup } = makeContext();
    try {
      const tool = buildCodeGraphStatusTool({ binary: FAKE_BINARY });
      const result = await tool.handler({
        context,
        arguments: { repo: '/etc/passwd' } as Record<string, unknown>,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});

describe('vibecode_codegraph_search', () => {
  test('happy path forwards query and maxResults to the runner', async () => {
    const { context, cleanup } = makeContext();
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const deps: CodeGraphSearchToolDeps = {
        runner: (command, args) => {
          calls.push({ command, args: [...args] });
          return { ok: true, stdout: JSON.stringify([{ score: 0.5, node: { name: 'foo' } }]), stderr: '', exitCode: 0 };
        },
        binary: FAKE_BINARY,
      };
      const tool = buildCodeGraphSearchTool(deps);
      const result = await tool.handler({
        context,
        arguments: { query: 'foo', maxResults: 5 },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      expect(calls.length).toBeGreaterThan(0);
      const args = calls[calls.length - 1].args;
      expect(args[0]).toBe('query');
      expect(args).toContain('--limit');
      expect(args).toContain('5');
      // Score should be normalized to raw_score, not surfaced as percentage.
      const data = result.structuredContent.data as { parsed_json: Array<Record<string, unknown>> };
      expect(Array.isArray(data.parsed_json)).toBe(true);
      expect(data.parsed_json[0].raw_score).toBe(0.5);
    } finally {
      cleanup();
    }
  });

  test('missing query is rejected with INVALID_ARGUMENT before any runner call', async () => {
    const { context, cleanup } = makeContext();
    try {
      const calls: number[] = [];
      const tool = buildCodeGraphSearchTool({
        runner: () => {
          calls.push(1);
          return { ok: true, stdout: '', stderr: '', exitCode: 0 };
        },
        binary: FAKE_BINARY,
      });
      const result = await tool.handler({ context, arguments: {}, requestId: null });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
      expect(calls.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('negative maxResults is rejected with INVALID_ARGUMENT', async () => {
    const { context, cleanup } = makeContext();
    try {
      const tool = buildCodeGraphSearchTool({ runner: fakeRunner('[]'), binary: FAKE_BINARY });
      const result = await tool.handler({
        context,
        arguments: { query: 'foo', maxResults: -3 },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});

describe('vibecode_codegraph_context', () => {
  test('happy path forwards query and maxNodes', async () => {
    const { context, cleanup } = makeContext();
    try {
      const calls: Array<string[]> = [];
      const deps = {
        runner: ((command: string, args: string[]) => {
          calls.push([...args]);
          return { ok: true, stdout: '# context\n\nstuff', stderr: '', exitCode: 0 };
        }) as CodeGraphActionRunner,
        binary: FAKE_BINARY,
      };
      const tool = buildCodeGraphContextTool(deps);
      const result = await tool.handler({
        context,
        arguments: { query: 'fix auth', maxNodes: 7 },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const args = calls[calls.length - 1];
      expect(args[0]).toBe('context');
      expect(args).toContain('--max-nodes');
      expect(args).toContain('7');
      expect(result.content[0].text).toContain('CodeGraph Context');
    } finally {
      cleanup();
    }
  });
});

describe('vibecode_codegraph_files', () => {
  test('limits parsed JSON output to the requested cap', async () => {
    const { context, cleanup } = makeContext();
    try {
      const deps: CodeGraphFilesToolDeps = {
        runner: fakeRunner(JSON.stringify(['a.ts', 'b.ts', 'c.ts'])),
        binary: FAKE_BINARY,
      };
      const tool = buildCodeGraphFilesTool(deps);
      const result = await tool.handler({
        context,
        arguments: { limit: 2 },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { parsed_json: unknown[] };
      expect(data.parsed_json).toEqual(['a.ts', 'b.ts']);
    } finally {
      cleanup();
    }
  });
});

describe('vibecode_codegraph_callers/callees/impact', () => {
  test('callers tool forwards the symbol argument', async () => {
    const { context, cleanup } = makeContext();
    try {
      const calls: string[][] = [];
      const deps: CodeGraphSymbolToolDeps = {
        runner: (command, args) => {
          calls.push([...args]);
          return { ok: true, stdout: '[]', stderr: '', exitCode: 0 };
        },
        binary: FAKE_BINARY,
      };
      const tool = buildCodeGraphCallersTool(deps);
      const result = await tool.handler({
        context,
        arguments: { symbol: 'doStuff', limit: 10 },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const args = calls[calls.length - 1];
      expect(args[0]).toBe('callers');
      expect(args).toContain('doStuff');
      expect(args).toContain('--limit');
      expect(args).toContain('10');
    } finally {
      cleanup();
    }
  });

  test('callees tool forwards the symbol argument', async () => {
    const { context, cleanup } = makeContext();
    try {
      const calls: string[][] = [];
      const tool = buildCodeGraphCalleesTool({
        runner: (command, args) => {
          calls.push([...args]);
          return { ok: true, stdout: '[]', stderr: '', exitCode: 0 };
        },
        binary: FAKE_BINARY,
      });
      const result = await tool.handler({
        context,
        arguments: { symbol: 'doStuff' },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      expect(calls[calls.length - 1][0]).toBe('callees');
    } finally {
      cleanup();
    }
  });

  test('impact tool forwards the input argument and maps limit to --depth', async () => {
    const { context, cleanup } = makeContext();
    try {
      const calls: string[][] = [];
      const tool = buildCodeGraphImpactTool({
        runner: (command, args) => {
          calls.push([...args]);
          return { ok: true, stdout: '[]', stderr: '', exitCode: 0 };
        },
        binary: FAKE_BINARY,
      });
      const result = await tool.handler({
        context,
        arguments: { input: 'doStuff', limit: 3 },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const args = calls[calls.length - 1];
      expect(args[0]).toBe('impact');
      expect(args).toContain('doStuff');
      expect(args).toContain('--depth');
      expect(args).toContain('3');
    } finally {
      cleanup();
    }
  });

  test('missing symbol is rejected with INVALID_ARGUMENT', async () => {
    const { context, cleanup } = makeContext();
    try {
      const tool = buildCodeGraphCallersTool({ runner: fakeRunner('[]'), binary: FAKE_BINARY });
      const result = await tool.handler({ context, arguments: {}, requestId: null });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});

describe('CodeGraph failure paths', () => {
  test('runner failure becomes CODEGRAPH_QUERY_FAILED', async () => {
    const { context, cleanup } = makeContext();
    try {
      const tool = buildCodeGraphSearchTool({
        runner: () => ({ ok: false, stdout: '', stderr: 'boom', exitCode: 1 }),
        binary: FAKE_BINARY,
      });
      const result = await tool.handler({
        context,
        arguments: { query: 'foo' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('CODEGRAPH_QUERY_FAILED');
      expect(result.structuredContent.error?.message).toMatch(/boom/);
    } finally {
      cleanup();
    }
  });

  test('missing .codegraph/ directory becomes CODEGRAPH_NOT_INITIALIZED', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-mcp-uninit-'));
    try {
      const tool = buildCodeGraphSearchTool({
        runner: fakeRunner('[]'),
        binary: FAKE_BINARY,
      });
      const result = await tool.handler({
        context: { repoRoot },
        arguments: { query: 'foo' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('CODEGRAPH_NOT_INITIALIZED');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
