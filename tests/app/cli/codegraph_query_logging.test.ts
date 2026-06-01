import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ADAPTER_PATH = '../../../src/adapters/codegraph/codegraph_query_commands.js';

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-cglog-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  return repoRoot;
}

function makeRunDir(repoRoot: string, runId: string): void {
  fs.mkdirSync(path.join(repoRoot, '.vibecode', 'runs', runId, 'terminal'), { recursive: true });
}

function readJsonl(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('vibecode codegraph query commands — logging + --run-id', () => {
  let tmpRepo: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let savedEnvRunId: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpRepo = makeRepo();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = 0;
    savedEnvRunId = process.env.VIBECODE_RUN_ID;
    delete process.env.VIBECODE_RUN_ID;
  });

  afterEach(() => {
    vi.doUnmock(ADAPTER_PATH);
    vi.resetModules();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
    if (savedEnvRunId === undefined) delete process.env.VIBECODE_RUN_ID;
    else process.env.VIBECODE_RUN_ID = savedEnvRunId;
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

  function mockOk(subcommand: string, stdout = 'result'): ReturnType<typeof vi.fn> {
    return vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', subcommand],
      repoRoot: tmpRepo,
      stdoutText: stdout,
      warnings: [],
    });
  }

  function workspaceLogPath(): string {
    return path.join(tmpRepo, '.vibecode', 'logs', 'codegraph_queries.jsonl');
  }

  function runLogPath(runId: string): string {
    return path.join(tmpRepo, '.vibecode', 'runs', runId, 'terminal', 'codegraph_queries.jsonl');
  }

  test('codegraph search writes a workspace-level log event', async () => {
    mockAdapter({ runCodeGraphSearch: mockOk('query') });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo]);

    const rows = readJsonl(workspaceLogPath());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'codegraph',
      subcommand: 'search',
      repo_root: tmpRepo,
      ok: true,
    });
  });

  test('--run-id causes a run-scoped log when the run dir exists', async () => {
    const runId = 'run-1';
    makeRunDir(tmpRepo, runId);
    mockAdapter({ runCodeGraphSearch: mockOk('query') });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo, '--run-id', runId]);

    expect(readJsonl(workspaceLogPath())).toHaveLength(1);
    const runRows = readJsonl(runLogPath(runId));
    expect(runRows).toHaveLength(1);
    expect((runRows[0] as { run_id: string }).run_id).toBe(runId);
  });

  test('explicit --run-id overrides VIBECODE_RUN_ID env', async () => {
    const explicit = 'explicit-run';
    const envRun = 'env-run';
    makeRunDir(tmpRepo, explicit);
    makeRunDir(tmpRepo, envRun);
    process.env.VIBECODE_RUN_ID = envRun;

    mockAdapter({ runCodeGraphSearch: mockOk('query') });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q',
      '--repo', tmpRepo,
      '--run-id', explicit,
    ]);

    expect(readJsonl(runLogPath(explicit))).toHaveLength(1);
    expect(readJsonl(runLogPath(envRun))).toHaveLength(0);
  });

  test('VIBECODE_RUN_ID is used when --run-id is absent', async () => {
    const envRun = 'env-only-run';
    makeRunDir(tmpRepo, envRun);
    process.env.VIBECODE_RUN_ID = envRun;

    mockAdapter({ runCodeGraphSearch: mockOk('query') });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo]);

    expect(readJsonl(runLogPath(envRun))).toHaveLength(1);
  });

  test('no run id means no run-scoped log is created', async () => {
    mockAdapter({ runCodeGraphSearch: mockOk('query') });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo]);

    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'runs'))).toBe(false);
    expect(readJsonl(workspaceLogPath())).toHaveLength(1);
  });

  test('provided but missing run id logs workspace-level only with warning, no fake dir', async () => {
    const ghost = 'does-not-exist';
    mockAdapter({ runCodeGraphSearch: mockOk('query') });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q',
      '--repo', tmpRepo,
      '--run-id', ghost,
      '--json',
    ]);

    expect(readJsonl(workspaceLogPath())).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'runs', ghost))).toBe(false);

    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.log).toBeDefined();
    expect(payload.log.warnings.join(' ')).toMatch(/RUN_LOG_SKIPPED_RUN_NOT_FOUND/);
  });

  test('failures are still logged with ok=false and error block', async () => {
    const runCodeGraphSearch = vi.fn().mockReturnValue({
      ok: false,
      command: ['codegraph', 'query'],
      repoRoot: tmpRepo,
      stdoutText: '',
      warnings: [],
      error: { code: 'CODEGRAPH_QUERY_FAILED', message: 'index lock' },
    });
    mockAdapter({ runCodeGraphSearch });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo, '--json']);

    const rows = readJsonl(workspaceLogPath());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ok: false,
      error: { code: 'CODEGRAPH_QUERY_FAILED' },
    });
  });

  test('NOT_INSTALLED is logged', async () => {
    const runCodeGraphSearch = vi.fn().mockReturnValue({
      ok: false,
      command: ['codegraph', 'query'],
      repoRoot: tmpRepo,
      warnings: [],
      error: { code: 'CODEGRAPH_NOT_INSTALLED', message: 'not installed' },
    });
    mockAdapter({ runCodeGraphSearch });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo]);

    const rows = readJsonl(workspaceLogPath()) as Array<{ ok: boolean; error: { code: string } }>;
    expect(rows[0]!.error.code).toBe('CODEGRAPH_NOT_INSTALLED');
  });

  test('NOT_INITIALIZED is logged', async () => {
    const runCodeGraphSearch = vi.fn().mockReturnValue({
      ok: false,
      command: ['codegraph', 'query'],
      repoRoot: tmpRepo,
      warnings: [],
      error: { code: 'CODEGRAPH_NOT_INITIALIZED', message: 'not initialized' },
    });
    mockAdapter({ runCodeGraphSearch });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo]);

    const rows = readJsonl(workspaceLogPath()) as Array<{ ok: boolean; error: { code: string } }>;
    expect(rows[0]!.error.code).toBe('CODEGRAPH_NOT_INITIALIZED');
  });

  test('all 6 commands log to workspace and accept --run-id', async () => {
    const runId = 'all-six';
    makeRunDir(tmpRepo, runId);
    mockAdapter({
      runCodeGraphSearch: mockOk('query'),
      runCodeGraphContextQuery: mockOk('context'),
      runCodeGraphFiles: mockOk('files'),
      runCodeGraphCallers: mockOk('callers'),
      runCodeGraphCallees: mockOk('callees'),
      runCodeGraphImpact: mockOk('impact'),
    });
    const { createCli } = await import('../../../src/app/cli/index.js');
    const cli = createCli();
    await cli.parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo, '--run-id', runId]);
    await cli.parseAsync(['node', 'vibecode', 'codegraph', 'context', 'q', '--repo', tmpRepo, '--run-id', runId]);
    await cli.parseAsync(['node', 'vibecode', 'codegraph', 'files', '--repo', tmpRepo, '--run-id', runId]);
    await cli.parseAsync(['node', 'vibecode', 'codegraph', 'callers', 'sym', '--repo', tmpRepo, '--run-id', runId]);
    await cli.parseAsync(['node', 'vibecode', 'codegraph', 'callees', 'sym', '--repo', tmpRepo, '--run-id', runId]);
    await cli.parseAsync(['node', 'vibecode', 'codegraph', 'impact', 'src/x.ts', '--repo', tmpRepo, '--run-id', runId]);

    const workspaceRows = readJsonl(workspaceLogPath()) as Array<{ subcommand: string }>;
    expect(workspaceRows.map((r) => r.subcommand)).toEqual([
      'search', 'context', 'files', 'callers', 'callees', 'impact',
    ]);
    const runRows = readJsonl(runLogPath(runId)) as Array<{ subcommand: string }>;
    expect(runRows).toHaveLength(6);
  });

  test('--json envelope includes log paths and warnings on success', async () => {
    const runId = 'env-run-2';
    makeRunDir(tmpRepo, runId);
    mockAdapter({ runCodeGraphSearch: mockOk('query', '[]') });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q',
      '--repo', tmpRepo,
      '--run-id', runId,
      '--json',
    ]);

    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.log).toBeDefined();
    expect(payload.log.workspace_log).toMatch(/codegraph_queries\.jsonl$/);
    expect(payload.log.run_log).toMatch(new RegExp(`${runId}.*codegraph_queries\\.jsonl$`));
    expect(Array.isArray(payload.log.warnings)).toBe(true);
  });

  test('logged events do not include full stdout/stderr text', async () => {
    const big = 'a'.repeat(5000);
    const runCodeGraphSearch = vi.fn().mockReturnValue({
      ok: true,
      command: ['codegraph', 'query'],
      repoRoot: tmpRepo,
      stdoutText: big,
      warnings: [],
    });
    mockAdapter({ runCodeGraphSearch });
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo]);

    const raw = fs.readFileSync(workspaceLogPath(), 'utf8');
    expect(raw.length).toBeLessThan(1500);
    expect(raw).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const ev = JSON.parse(raw.trim());
    expect(ev).not.toHaveProperty('stdout');
    expect(ev).not.toHaveProperty('stdoutText');
    expect(ev.result_summary.stdout_bytes).toBeGreaterThan(0);
  });

  test('logging never blocks command success when log write fails', async () => {
    mockAdapter({ runCodeGraphSearch: mockOk('query') });
    const { createCli } = await import('../../../src/app/cli/index.js');

    // Make the workspace logs dir un-writable by creating it as a *file*.
    fs.mkdirSync(path.join(tmpRepo, '.vibecode'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, '.vibecode', 'logs'), 'block', 'utf8');

    await createCli().parseAsync([
      'node', 'vibecode', 'codegraph', 'search', 'q', '--repo', tmpRepo, '--json',
    ]);

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(payload.ok).toBe(true);
    expect(payload.log.warnings.join(' ')).toMatch(/CODEGRAPH_QUERY_LOG_WRITE_FAILED/);
  });
});
