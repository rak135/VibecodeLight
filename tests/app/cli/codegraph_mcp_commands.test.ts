import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-mcp-cmds-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

describe('vibecode codegraph mcp self-test', () => {
  let tmpRepo: string;

  beforeEach(() => {
    vi.resetModules();
    tmpRepo = makeRepo();
  });

  afterEach(() => {
    vi.doUnmock('../../../src/adapters/codegraph/codegraph_mcp.js');
    vi.resetModules();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('--json prints success envelope with expected tools and ok=true', async () => {
    const runCodeGraphMcpSelfTest = vi.fn().mockResolvedValue({
      ok: true,
      transport: 'stdio',
      serverCommand: 'codegraph',
      serverArgs: ['serve', '--mcp'],
      repoRoot: tmpRepo,
      tools: [
        'codegraph_status',
        'codegraph_context',
        'codegraph_search',
        'codegraph_files',
        'codegraph_trace',
      ],
      expectedToolsPresent: true,
      missingTools: [],
      warnings: [],
    });

    vi.doMock('../../../src/adapters/codegraph/codegraph_mcp.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_mcp.js')>(
        '../../../src/adapters/codegraph/codegraph_mcp.js',
      );
      return { ...actual, runCodeGraphMcpSelfTest };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.exitCode = 0;
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'self-test', '--repo', tmpRepo, '--json',
      ]);

      expect(runCodeGraphMcpSelfTest).toHaveBeenCalledTimes(1);
      const callArg = runCodeGraphMcpSelfTest.mock.calls[0]![0] as { repoRoot: string };
      expect(callArg.repoRoot).toBe(path.resolve(tmpRepo));

      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload).toMatchObject({
        ok: true,
        transport: 'stdio',
        serverCommand: 'codegraph serve --mcp',
        repoRoot: tmpRepo,
        expectedToolsPresent: true,
        missingTools: [],
      });
      expect(payload.tools).toContain('codegraph_status');
      expect(payload.tools).toContain('codegraph_context');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  test('human output lists tools and reports OK header', async () => {
    const runCodeGraphMcpSelfTest = vi.fn().mockResolvedValue({
      ok: true,
      transport: 'stdio',
      serverCommand: 'codegraph',
      serverArgs: ['serve', '--mcp'],
      repoRoot: tmpRepo,
      tools: ['codegraph_status', 'codegraph_context', 'codegraph_search', 'codegraph_files'],
      expectedToolsPresent: true,
      missingTools: [],
      warnings: [],
    });

    vi.doMock('../../../src/adapters/codegraph/codegraph_mcp.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_mcp.js')>(
        '../../../src/adapters/codegraph/codegraph_mcp.js',
      );
      return { ...actual, runCodeGraphMcpSelfTest };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'self-test', '--repo', tmpRepo,
      ]);

      const lines = logSpy.mock.calls.map((args) => String(args[0]));
      expect(lines.some((line) => line.includes('CodeGraph MCP self-test: OK'))).toBe(true);
      expect(lines.some((line) => line.includes('Server: codegraph serve --mcp'))).toBe(true);
      expect(lines.some((line) => line.includes('codegraph_status'))).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('missing expected tools surface in --json output with ok=false and exit code 1', async () => {
    const runCodeGraphMcpSelfTest = vi.fn().mockResolvedValue({
      ok: false,
      transport: 'stdio',
      serverCommand: 'codegraph',
      serverArgs: ['serve', '--mcp'],
      repoRoot: tmpRepo,
      tools: ['codegraph_status', 'codegraph_search', 'codegraph_files'],
      expectedToolsPresent: false,
      missingTools: ['codegraph_context'],
      warnings: [],
      error: {
        code: 'CODEGRAPH_MCP_TOOLS_MISSING',
        message: 'CodeGraph MCP server is missing expected tools: codegraph_context',
      },
    });

    vi.doMock('../../../src/adapters/codegraph/codegraph_mcp.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_mcp.js')>(
        '../../../src/adapters/codegraph/codegraph_mcp.js',
      );
      return { ...actual, runCodeGraphMcpSelfTest };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.exitCode = 0;
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'self-test', '--repo', tmpRepo, '--json',
      ]);

      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.ok).toBe(false);
      expect(payload.missingTools).toEqual(['codegraph_context']);
      expect(payload.error.code).toBe('CODEGRAPH_MCP_TOOLS_MISSING');
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  test('server startup failure produces structured human diagnostic with no stack trace', async () => {
    const runCodeGraphMcpSelfTest = vi.fn().mockResolvedValue({
      ok: false,
      transport: 'stdio',
      serverCommand: 'codegraph',
      serverArgs: ['serve', '--mcp'],
      repoRoot: tmpRepo,
      tools: [],
      expectedToolsPresent: false,
      missingTools: ['codegraph_status', 'codegraph_context', 'codegraph_search', 'codegraph_files'],
      warnings: ['CODEGRAPH_NOT_FOUND: codegraph command was not found or not callable'],
      error: {
        code: 'CODEGRAPH_BINARY_NOT_FOUND',
        message: 'codegraph command was not found on PATH',
      },
    });

    vi.doMock('../../../src/adapters/codegraph/codegraph_mcp.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_mcp.js')>(
        '../../../src/adapters/codegraph/codegraph_mcp.js',
      );
      return { ...actual, runCodeGraphMcpSelfTest };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.exitCode = 0;
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'self-test', '--repo', tmpRepo,
      ]);

      const errorLines = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(errorLines.some((line) => line.includes('FAILED'))).toBe(true);
      expect(errorLines.some((line) => line.includes('CODEGRAPH_BINARY_NOT_FOUND'))).toBe(true);
      expect(errorLines.some((line) => line.includes('Stack') || line.includes('Trace'))).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  test('invalid --timeout fails with a structured diagnostic and never calls self-test', async () => {
    const runCodeGraphMcpSelfTest = vi.fn();
    vi.doMock('../../../src/adapters/codegraph/codegraph_mcp.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_mcp.js')>(
        '../../../src/adapters/codegraph/codegraph_mcp.js',
      );
      return { ...actual, runCodeGraphMcpSelfTest };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.exitCode = 0;
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'self-test',
        '--repo', tmpRepo, '--json', '--timeout', 'banana',
      ]);

      expect(runCodeGraphMcpSelfTest).not.toHaveBeenCalled();
      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('INVALID_TIMEOUT');
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });
});

describe('vibecode codegraph mcp config', () => {
  let tmpRepo: string;

  beforeEach(() => {
    vi.resetModules();
    tmpRepo = makeRepo();
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('claude prints stdio config snippet and never writes files', async () => {
    const repoFilesBefore = fs.readdirSync(tmpRepo).sort();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'config',
        '--agent', 'claude', '--repo', tmpRepo, '--print',
      ]);

      const printed = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(printed).toContain('codegraph');
      expect(printed).toContain('"serve"');
      expect(printed).toContain('"--mcp"');
      expect(printed).toContain('"stdio"');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(fs.readdirSync(tmpRepo).sort()).toEqual(repoFilesBefore);
  });

  test('--json prints a canonical envelope with claude config', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'config',
        '--agent', 'claude', '--repo', tmpRepo, '--json',
      ]);

      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.ok).toBe(true);
      expect(payload.data.agent).toBe('claude');
      expect(payload.data.config).toEqual({
        mcpServers: {
          codegraph: {
            type: 'stdio',
            command: 'codegraph',
            args: ['serve', '--mcp'],
          },
        },
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('unknown agent returns AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED or UNKNOWN_AGENT', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.exitCode = 0;
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'config',
        '--agent', 'cursor', '--repo', tmpRepo, '--json',
      ]);

      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.ok).toBe(false);
      expect(['UNKNOWN_AGENT', 'AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED']).toContain(payload.error.code);
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  test('known-but-unimplemented agent returns AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.exitCode = 0;
      const { createCli } = await import('../../../src/app/cli/index.js');
      await createCli().parseAsync([
        'node', 'vibecode', 'codegraph', 'mcp', 'config',
        '--agent', 'codex', '--repo', tmpRepo, '--json',
      ]);

      const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('AGENT_CONFIG_FORMAT_NOT_IMPLEMENTED');
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });
});
