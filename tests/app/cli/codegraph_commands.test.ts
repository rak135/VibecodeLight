import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeRepo(): string {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-codegraph-cmds-'));
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# CodeGraph command fixture\n', 'utf8');
  return tmpRepo;
}

describe('vibecode codegraph command namespace', () => {
  let tmpRepo: string;

  beforeEach(() => {
    vi.resetModules();
    tmpRepo = makeRepo();
  });

  afterEach(() => {
    vi.doUnmock('../../../src/adapters/codegraph/codegraph_actions.js');
    vi.resetModules();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('status routes to getCodeGraphStatus and prints canonical JSON envelope', async () => {
    const getCodeGraphStatus = vi.fn().mockResolvedValue({
      ok: true,
      available: true,
      initialized: true,
      version: 'v1.2.3',
      warnings: [],
    });
    vi.doMock('../../../src/adapters/codegraph/codegraph_actions.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_actions.js')>(
        '../../../src/adapters/codegraph/codegraph_actions.js',
      );
      return {
        ...actual,
        getCodeGraphStatus,
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { createCli } = await import('../../../src/app/cli/index.js');
      const cli = createCli();
      process.exitCode = 0;
      await cli.parseAsync(['node', 'vibecode', 'codegraph', 'status', '--repo', tmpRepo, '--json']);

      expect(getCodeGraphStatus).toHaveBeenCalledWith(tmpRepo);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({
        ok: true,
        data: {
          available: true,
          initialized: true,
          version: 'v1.2.3',
        },
        artifacts: [],
        warnings: [],
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  test('init routes to initializeCodeGraphRepo', async () => {
    const initializeCodeGraphRepo = vi.fn().mockResolvedValue({
      ok: true,
      stdoutSummary: 'initialized',
      stderrSummary: '',
    });
    vi.doMock('../../../src/adapters/codegraph/codegraph_actions.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_actions.js')>(
        '../../../src/adapters/codegraph/codegraph_actions.js',
      );
      return {
        ...actual,
        initializeCodeGraphRepo,
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { createCli } = await import('../../../src/app/cli/index.js');
      const cli = createCli();
      process.exitCode = 0;
      await cli.parseAsync(['node', 'vibecode', 'codegraph', 'init', '--repo', tmpRepo, '--json']);

      expect(initializeCodeGraphRepo).toHaveBeenCalledWith(tmpRepo);
      expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({
        ok: true,
        data: {
          stdout: 'initialized',
          stderr: '',
        },
        artifacts: [],
        warnings: [],
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  test('sync routes to syncCodeGraphRepo', async () => {
    const syncCodeGraphRepo = vi.fn().mockResolvedValue({
      ok: true,
      stdoutSummary: 'synced',
      stderrSummary: '',
    });
    vi.doMock('../../../src/adapters/codegraph/codegraph_actions.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_actions.js')>(
        '../../../src/adapters/codegraph/codegraph_actions.js',
      );
      return {
        ...actual,
        syncCodeGraphRepo,
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { createCli } = await import('../../../src/app/cli/index.js');
      const cli = createCli();
      process.exitCode = 0;
      await cli.parseAsync(['node', 'vibecode', 'codegraph', 'sync', '--repo', tmpRepo, '--json']);

      expect(syncCodeGraphRepo).toHaveBeenCalledWith(tmpRepo);
      expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({
        ok: true,
        data: {
          stdout: 'synced',
          stderr: '',
        },
        artifacts: [],
        warnings: [],
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  test('reindex routes to reindexCodeGraphRepo', async () => {
    const reindexCodeGraphRepo = vi.fn().mockResolvedValue({
      ok: true,
      stdoutSummary: 'reindexed',
      stderrSummary: '',
    });
    vi.doMock('../../../src/adapters/codegraph/codegraph_actions.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_actions.js')>(
        '../../../src/adapters/codegraph/codegraph_actions.js',
      );
      return {
        ...actual,
        reindexCodeGraphRepo,
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { createCli } = await import('../../../src/app/cli/index.js');
      const cli = createCli();
      process.exitCode = 0;
      await cli.parseAsync(['node', 'vibecode', 'codegraph', 'reindex', '--repo', tmpRepo, '--json']);

      expect(reindexCodeGraphRepo).toHaveBeenCalledWith(tmpRepo);
      expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({
        ok: true,
        data: {
          stdout: 'reindexed',
          stderr: '',
        },
        artifacts: [],
        warnings: [],
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = 0;
    }
  });
});
