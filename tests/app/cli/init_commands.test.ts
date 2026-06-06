import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

describe('init CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('init --json returns the canonical success envelope with existing init fields under data', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-init-json-');
    try {
      const result = await runCli(['init', '--repo', repoRoot, '--json']);

      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(1);
      const payload = JSON.parse(result.logs[0]) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['artifacts', 'data', 'ok', 'warnings']);
      expect(payload).toMatchObject({
        ok: true,
        data: {
          created: expect.arrayContaining(['.vibecode', '.vibecode/runs', '.vibecode/current', '.vibecode/config.yaml', '.gitignore']),
          existing: [],
        },
        warnings: [],
      });
      expect(payload.data).toEqual(expect.any(Object));
      expect(payload).not.toHaveProperty('created');
      expect(payload).not.toHaveProperty('existing');
      expect(payload.artifacts).toEqual(expect.arrayContaining([
        path.join(repoRoot, '.vibecode'),
        path.join(repoRoot, '.vibecode', 'runs'),
        path.join(repoRoot, '.vibecode', 'current'),
        path.join(repoRoot, '.vibecode', 'config.yaml'),
        path.join(repoRoot, '.gitignore'),
      ]));
    } finally {
      cleanup();
    }
  });

  test('init without --json keeps the existing raw initializer JSON shape', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-init-default-');
    try {
      const result = await runCli(['init', '--repo', repoRoot]);

      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(1);
      const payload = JSON.parse(result.logs[0]) as Record<string, unknown>;
      expect(payload).toMatchObject({
        created: expect.arrayContaining(['.vibecode', '.vibecode/runs', '.vibecode/current']),
        existing: [],
      });
      expect(payload).not.toHaveProperty('ok');
      expect(payload).not.toHaveProperty('data');
    } finally {
      cleanup();
    }
  });

  test('init --json returns the canonical structured error envelope on expected failure', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-init-json-failure-');
    const repoFile = path.join(repoRoot, 'not-a-directory');
    fs.writeFileSync(repoFile, 'plain file\n', 'utf8');
    try {
      const result = await runCli(['init', '--repo', repoFile, '--json']);

      expect(result.exitCode).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.logs).toHaveLength(1);
      const payload = JSON.parse(result.logs[0]) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['error', 'ok']);
      expect(payload).toMatchObject({
        ok: false,
        error: {
          code: 'INIT_FAILED',
          path: repoFile,
          details: expect.any(Array),
        },
      });
      expect((payload.error as { message?: unknown }).message).toEqual(expect.any(String));
    } finally {
      cleanup();
    }
  });
});
