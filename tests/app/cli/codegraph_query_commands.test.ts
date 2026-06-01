import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-codegraph-query-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  return repoRoot;
}

const ADAPTER_PATH = '../../../src/adapters/codegraph/codegraph_query_commands.js';

describe('vibecode codegraph query commands (CLI)', () => {
  let tmpRepo: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    tmpRepo = makeRepo();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.doUnmock(ADAPTER_PATH);
    vi.resetModules();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  function mockAdapter(fns: Record<string, ReturnType<typeof vi.fn>>): void {
    vi.doMock(ADAPTER_PATH, async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_query_commands.js')>(
        ADAPTER_PATH,
      );
      return { ...actual, ...fns };
    });
  }

  test('search forwards --repo, --json, --max-results, --timeout to adapter', async () => {
    const runCodeGraphSearch = vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', 'query', '--path', tmpRepo, 'q', '--limit', '5', '--json'],
      repoRoot: tmpRepo,
      stdoutText: '[]',
      parsedJson: [],
      warnings: [],
    });
    mockAdapter({ runCodeGraphSearch });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q',
      '--repo', tmpRepo,
      '--json',
      '--max-results', '5',
      '--timeout', '12345',
    ]);

    expect(runCodeGraphSearch).toHaveBeenCalledTimes(1);
    expect(runCodeGraphSearch.mock.calls[0]![0]).toMatchObject({
      repoRoot: tmpRepo,
      query: 'q',
      maxResults: 5,
      timeoutMs: 12345,
      json: true,
      command: 'codegraph',
      binarySource: 'PATH_FALLBACK',
    });
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.ok).toBe(true);
    expect(payload.command).toContain('query');
    expect(payload.repoRoot).toBe(tmpRepo);
    expect(payload.query).toBe('q');
    expect(payload.parsedJson).toEqual([]);
  });

  test('context forwards --max-nodes and --max-code', async () => {
    const runCodeGraphContextQuery = vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', 'context'],
      repoRoot: tmpRepo,
      stdoutText: '# ctx',
      warnings: [],
    });
    mockAdapter({ runCodeGraphContextQuery });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'context', 'persistence',
      '--repo', tmpRepo,
      '--max-nodes', '40',
      '--max-code', '8',
    ]);

    expect(runCodeGraphContextQuery.mock.calls[0]![0]).toMatchObject({
      repoRoot: tmpRepo,
      query: 'persistence',
      maxNodes: 40,
      maxCode: 8,
      command: 'codegraph',
      binarySource: 'PATH_FALLBACK',
    });
  });

  test('callers requires symbol and forwards --limit', async () => {
    const runCodeGraphCallers = vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', 'callers'],
      repoRoot: tmpRepo,
      stdoutText: '',
      warnings: [],
    });
    mockAdapter({ runCodeGraphCallers });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'callers', 'mySymbol',
      '--repo', tmpRepo,
      '--limit', '7',
    ]);

    expect(runCodeGraphCallers.mock.calls[0]![0]).toMatchObject({
      repoRoot: tmpRepo,
      symbol: 'mySymbol',
      limit: 7,
    });
  });

  test('impact forwards input argument', async () => {
    const runCodeGraphImpact = vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', 'impact'],
      repoRoot: tmpRepo,
      stdoutText: '',
      warnings: [],
    });
    mockAdapter({ runCodeGraphImpact });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'impact', 'src/lib.ts',
      '--repo', tmpRepo,
      '--limit', '3',
    ]);

    expect(runCodeGraphImpact.mock.calls[0]![0]).toMatchObject({
      repoRoot: tmpRepo,
      symbol: 'src/lib.ts',
      limit: 3,
    });
  });

  test('files forwards --limit and --json', async () => {
    const runCodeGraphFiles = vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', 'files', '--path', tmpRepo, '--json'],
      repoRoot: tmpRepo,
      stdoutText: '[]',
      parsedJson: [],
      warnings: [],
    });
    mockAdapter({ runCodeGraphFiles });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'files',
      '--repo', tmpRepo,
      '--limit', '100',
      '--json',
    ]);

    expect(runCodeGraphFiles.mock.calls[0]![0]).toMatchObject({
      repoRoot: tmpRepo,
      limit: 100,
      json: true,
    });
  });

  test('non-positive --max-results returns structured error and does not call adapter', async () => {
    const runCodeGraphSearch = vi.fn();
    mockAdapter({ runCodeGraphSearch });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q',
      '--repo', tmpRepo,
      '--max-results', '-1',
      '--json',
    ]);

    expect(runCodeGraphSearch).not.toHaveBeenCalled();
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('INVALID_ARGUMENT');
    expect(process.exitCode).toBe(1);
  });

  test('JSON envelope is stable and includes ok/command/repoRoot/warnings/error on failure', async () => {
    const runCodeGraphSearch = vi.fn().mockReturnValue({
      ok: false,
      command: ['codegraph', 'query', '--path', tmpRepo, 'q'],
      repoRoot: tmpRepo,
      stdoutText: '',
      warnings: ['CODEGRAPH_STDERR: some warning'],
      error: { code: 'CODEGRAPH_NOT_INITIALIZED', message: 'not initialized' },
    });
    mockAdapter({ runCodeGraphSearch });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q',
      '--repo', tmpRepo,
      '--json',
    ]);

    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({
      ok: false,
      command: expect.any(Array),
      repoRoot: tmpRepo,
      query: 'q',
      warnings: ['CODEGRAPH_STDERR: some warning'],
      error: { code: 'CODEGRAPH_NOT_INITIALIZED', message: 'not initialized' },
    });
    expect(process.exitCode).toBe(1);
  });

  test('default human output is concise: header, repo, results, command, warnings', async () => {
    const runCodeGraphSearch = vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', 'query', '--path', tmpRepo, 'q'],
      repoRoot: tmpRepo,
      stdoutText: 'result line 1\nresult line 2',
      warnings: [],
    });
    mockAdapter({ runCodeGraphSearch });

    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q',
      '--repo', tmpRepo,
    ]);

    const joined = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joined).toContain('# CodeGraph Search');
    expect(joined).toContain('Query: q');
    expect(joined).toContain(`Repo: ${tmpRepo}`);
    expect(joined).toContain('result line 1');
    expect(joined).toContain('Command: codegraph query');
    expect(joined).toContain('Warnings: none');
  });
});
