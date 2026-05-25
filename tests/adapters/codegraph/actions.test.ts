/**
 * Tests for CodeGraph explicit action service (Phase 1.6).
 *
 * Anti-scope assertions:
 * - No init/sync/reindex runs during status detection.
 * - No MCP, no context enrichment, no agent config writes.
 * - Commands only run when explicitly called.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';

import {
  type CodeGraphActionRunner,
  getCodeGraphStatus,
  initializeCodeGraphRepo,
  syncCodeGraphRepo,
  reindexCodeGraphRepo,
} from '../../../src/adapters/codegraph/codegraph_actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunner(
  overrides: Partial<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }> = {},
): { runner: CodeGraphActionRunner; calls: Array<{ command: string; args: string[]; cwd: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: CodeGraphActionRunner = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (overrides.error) {
      return { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: overrides.error.message };
    }
    const status = overrides.status ?? 0;
    return {
      ok: status === 0,
      stdout: overrides.stdout ?? '',
      stderr: overrides.stderr ?? '',
      exitCode: status,
    };
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// A. Service command construction
// ---------------------------------------------------------------------------

describe('getCodeGraphStatus — detect-only, no mutation', () => {
  test('uses the read-only version probe, never calls init/index/sync/watch', async () => {
    const { runner, calls } = makeRunner({ status: 0, stdout: '0.9.4' });
    const result = await getCodeGraphStatus('/repo/root', { runner });
    // The runner should NOT have been called with any mutating command
    for (const call of calls) {
      expect(call.args).not.toContain('init');
      expect(call.args).not.toContain('index');
      expect(call.args).not.toContain('sync');
      expect(call.args).not.toContain('watch');
    }
    expect(result.ok).toBe(true);
  });

  test('returns structured result with available, initialized, version fields', async () => {
    const { runner } = makeRunner({ status: 0, stdout: '0.9.4' });
    const result = await getCodeGraphStatus('/repo/root', { runner });
    expect(result).toMatchObject({ ok: true });
    expect(typeof result.available).toBe('boolean');
    expect(typeof result.initialized).toBe('boolean');
  });
});

describe('initializeCodeGraphRepo — command construction', () => {
  test('uses explicit repoRoot as cwd', async () => {
    const { runner, calls } = makeRunner({ status: 0 });
    await initializeCodeGraphRepo('/my/repo', { runner });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const initCall = calls.find((c) => c.args.includes('init'));
    expect(initCall).toBeDefined();
    expect(initCall!.cwd).toBe('/my/repo');
  });

  test('runs codegraph init -i', async () => {
    const { runner, calls } = makeRunner({ status: 0 });
    await initializeCodeGraphRepo('/my/repo', { runner });
    const initCall = calls.find((c) => c.args.includes('init'));
    expect(initCall).toBeDefined();
    expect(initCall!.args).toContain('init');
    expect(initCall!.args).toContain('-i');
  });

  test('returns ok=true on success', async () => {
    const { runner } = makeRunner({ status: 0 });
    const result = await initializeCodeGraphRepo('/my/repo', { runner });
    expect(result.ok).toBe(true);
  });

  test('returns ok=false with structured error on command failure', async () => {
    const { runner } = makeRunner({ status: 1, stderr: 'permission denied' });
    const result = await initializeCodeGraphRepo('/my/repo', { runner });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBeTruthy();
  });

  test('returns ok=false with structured error on spawn error', async () => {
    const { runner } = makeRunner({ error: new Error('ENOENT') });
    const result = await initializeCodeGraphRepo('/my/repo', { runner });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('syncCodeGraphRepo — command construction', () => {
  test('uses explicit repoRoot as cwd', async () => {
    const { runner, calls } = makeRunner({ status: 0 });
    await syncCodeGraphRepo('/my/repo', { runner });
    const syncCall = calls.find((c) => c.args.includes('sync'));
    expect(syncCall).toBeDefined();
    expect(syncCall!.cwd).toBe('/my/repo');
  });

  test('runs codegraph sync', async () => {
    const { runner, calls } = makeRunner({ status: 0 });
    await syncCodeGraphRepo('/my/repo', { runner });
    const syncCall = calls.find((c) => c.args.includes('sync'));
    expect(syncCall).toBeDefined();
    expect(syncCall!.command).toContain('codegraph');
    expect(syncCall!.args).toEqual(['sync']);
  });

  test('returns ok=true on success', async () => {
    const { runner } = makeRunner({ status: 0 });
    const result = await syncCodeGraphRepo('/my/repo', { runner });
    expect(result.ok).toBe(true);
  });

  test('returns ok=false with structured error on command failure', async () => {
    const { runner } = makeRunner({ status: 1, stderr: 'sync failed' });
    const result = await syncCodeGraphRepo('/my/repo', { runner });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('reindexCodeGraphRepo — command construction', () => {
  test('uses explicit repoRoot as cwd', async () => {
    const { runner, calls } = makeRunner({ status: 0 });
    await reindexCodeGraphRepo('/my/repo', { runner });
    const indexCall = calls.find((c) => c.args.includes('index'));
    expect(indexCall).toBeDefined();
    expect(indexCall!.cwd).toBe('/my/repo');
  });

  test('runs codegraph index --force', async () => {
    const { runner, calls } = makeRunner({ status: 0 });
    await reindexCodeGraphRepo('/my/repo', { runner });
    const indexCall = calls.find((c) => c.args.includes('index'));
    expect(indexCall).toBeDefined();
    expect(indexCall!.args).toContain('index');
    expect(indexCall!.args).toContain('--force');
  });

  test('returns ok=true on success', async () => {
    const { runner } = makeRunner({ status: 0 });
    const result = await reindexCodeGraphRepo('/my/repo', { runner });
    expect(result.ok).toBe(true);
  });

  test('returns ok=false with structured error on command failure', async () => {
    const { runner } = makeRunner({ status: 1, stderr: 'index failed' });
    const result = await reindexCodeGraphRepo('/my/repo', { runner });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// B. Anti-scope: status detection never mutates
// ---------------------------------------------------------------------------

describe('anti-scope: no mutating calls during status detection', () => {
  test('getCodeGraphStatus does not call init', async () => {
    const { runner, calls } = makeRunner();
    await getCodeGraphStatus('/repo/root', { runner });
    expect(calls.some((c) => c.args.includes('init'))).toBe(false);
  });

  test('getCodeGraphStatus does not call sync', async () => {
    const { runner, calls } = makeRunner();
    await getCodeGraphStatus('/repo/root', { runner });
    expect(calls.some((c) => c.args.includes('sync'))).toBe(false);
  });

  test('getCodeGraphStatus does not call index', async () => {
    const { runner, calls } = makeRunner();
    await getCodeGraphStatus('/repo/root', { runner });
    expect(calls.some((c) => c.args.includes('index'))).toBe(false);
  });

  test('getCodeGraphStatus does not call watch', async () => {
    const { runner, calls } = makeRunner();
    await getCodeGraphStatus('/repo/root', { runner });
    expect(calls.some((c) => c.args.includes('watch'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. Output bounding: no raw unbounded terminal dump
// ---------------------------------------------------------------------------

describe('output bounding', () => {
  test('initializeCodeGraphRepo bounds stdout in result', async () => {
    const longOutput = 'x'.repeat(100_000);
    const { runner } = makeRunner({ status: 0, stdout: longOutput });
    const result = await initializeCodeGraphRepo('/my/repo', { runner });
    expect(result.stdoutSummary).toBeDefined();
    expect(result.stdoutSummary!.length).toBeLessThanOrEqual(2000);
  });

  test('syncCodeGraphRepo bounds stderr in result', async () => {
    const longOutput = 'e'.repeat(100_000);
    const { runner } = makeRunner({ status: 1, stderr: longOutput });
    const result = await syncCodeGraphRepo('/my/repo', { runner });
    expect(result.stderrSummary).toBeDefined();
    expect(result.stderrSummary!.length).toBeLessThanOrEqual(2000);
  });
});
