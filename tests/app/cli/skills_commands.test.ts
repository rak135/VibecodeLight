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

describe('skills CLI commands', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock(STRUCTURED_OUTPUT_PATH);
    vi.resetModules();
  });

  test('copy of unknown skill returns the canonical structured JSON error shape', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-skills-unknown-');
    try {
      const result = await runCli(['skills', 'copy', 'missing-skill', '--repo', repoRoot, '--json']);

      expect(result.exitCode).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(1);
      const payload = JSON.parse(result.logs[0]) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['error', 'ok']);
      expect(payload).toEqual({
        ok: false,
        error: {
          code: 'SKILL_NOT_FOUND',
          message: 'skill "missing-skill" was not found in user-profile skills',
          path: '',
          details: [],
        },
      });
    } finally {
      cleanup();
    }
  });

  test('copy missing skill id routes the expected error through the shared helper', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-skills-helper-');
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
      const result = await runCli(['skills', 'copy', '--repo', repoRoot, '--json']);

      expect(result.exitCode).toBe(1);
      expect(makeCliStructuredError).toHaveBeenCalledWith(
        'MISSING_SKILL_ID',
        'skill id is required when --all is not specified',
      );
      expect(emitCliStructuredError).toHaveBeenCalledWith(
        {
          code: 'MISSING_SKILL_ID',
          message: 'skill id is required when --all is not specified',
          path: '',
          details: [],
        },
        { json: true, prefix: 'skills copy failed' },
      );
    } finally {
      cleanup();
    }
  });

  test('list --json success output is unchanged for an empty catalog', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-skills-success-');
    try {
      const result = await runCli(['skills', 'list', '--repo', repoRoot, '--json']);

      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(1);
      expect(JSON.parse(result.logs[0])).toEqual({
        ok: true,
        data: { skills: [] },
        artifacts: [],
        warnings: [],
      });
    } finally {
      cleanup();
    }
  });
});
