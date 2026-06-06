import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const STRUCTURED_OUTPUT_PATH = '../../../src/app/cli/structured_output.js';

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

async function runCli(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.exitCode = 0;
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', ...args]);
    return {
      logs: logSpy.mock.calls.map((call) => String(call[0])),
      errors: errorSpy.mock.calls.map((call) => String(call[0])),
      exitCode: Number(process.exitCode ?? 0),
    };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  }
}

describe('config CLI commands', () => {
  const priorLocalAppData = process.env.LOCALAPPDATA;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock(STRUCTURED_OUTPUT_PATH);
    vi.resetModules();
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
  });

  test('sync without direction returns the canonical structured JSON error shape', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-config-direction-');
    try {
      const result = await runCli(['config', 'sync', '--repo', repoRoot, '--json']);

      expect(result.exitCode).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(1);
      const payload = JSON.parse(result.logs[0]) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['error', 'ok']);
      expect(payload).toEqual({
        ok: false,
        error: {
          code: 'SYNC_DIRECTION_REQUIRED',
          message: 'config sync requires --from-global',
          path: '',
          details: [],
        },
      });
    } finally {
      cleanup();
    }
  });

  test('sync disabled to-global path routes the expected error through the shared helper', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-config-helper-');
    const makeCliStructuredError = vi.fn((code: string, message: string, pathValue = '', details: string[] = []) => ({
      code,
      message,
      path: pathValue,
      details,
    }));
    const emitCliStructuredError = vi.fn((error: unknown) => {
      console.log(JSON.stringify({ ok: false, error }));
      process.exitCode = 1;
    });
    vi.doMock(STRUCTURED_OUTPUT_PATH, () => ({
      makeCliStructuredError,
      emitCliStructuredError,
      printJson: (payload: unknown) => console.log(JSON.stringify(payload)),
    }));

    try {
      const result = await runCli(['config', 'sync', '--repo', repoRoot, '--to-global', '--json']);

      expect(result.exitCode).toBe(1);
      expect(makeCliStructuredError).toHaveBeenCalledWith(
        'CONFIG_SYNC_TO_GLOBAL_DISABLED',
        'Local-to-global config sync is disabled. Use global-to-local sync only.',
      );
      expect(emitCliStructuredError).toHaveBeenCalledWith(
        {
          code: 'CONFIG_SYNC_TO_GLOBAL_DISABLED',
          message: 'Local-to-global config sync is disabled. Use global-to-local sync only.',
          path: '',
          details: [],
        },
        { json: true, prefix: 'config sync failed' },
      );
    } finally {
      cleanup();
    }
  });

  test('sync --from-global --json success output is unchanged', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-config-success-');
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-appdata-'));
    process.env.LOCALAPPDATA = localAppData;
    const globalDir = path.join(localAppData, 'vibecodelight');
    const globalConfig = path.join(globalDir, 'config.yaml');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(globalConfig, 'providers: {}\n', 'utf8');
    try {
      const result = await runCli(['config', 'sync', '--repo', repoRoot, '--from-global', '--json']);
      const localConfig = path.join(repoRoot, '.vibecode', 'config.yaml');

      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(1);
      expect(JSON.parse(result.logs[0])).toEqual({
        ok: true,
        data: {
          direction: 'from-global',
          source: globalConfig,
          destination: localConfig,
        },
        artifacts: [localConfig],
        warnings: [],
      });
    } finally {
      fs.rmSync(localAppData, { recursive: true, force: true });
      cleanup();
    }
  });
});
