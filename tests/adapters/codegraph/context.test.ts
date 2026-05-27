import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  buildCodeGraphContext,
  parseWindowsNpmShimTarget,
  writeCodeGraphContextArtifacts,
  type CodeGraphContextRunner,
  type CodeGraphReadinessProvider,
} from '../../../src/adapters/codegraph/codegraph_context.js';

function tempRun(): { repoRoot: string; runDir: string; scanDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-context-'));
  const runDir = path.join(repoRoot, '.vibecode', 'runs', '20260525_000001');
  const scanDir = path.join(runDir, 'scan');
  fs.mkdirSync(scanDir, { recursive: true });
  return { repoRoot, runDir, scanDir };
}

function readyProvider(overrides: Partial<Awaited<ReturnType<CodeGraphReadinessProvider>>> = {}): CodeGraphReadinessProvider {
  return async () => ({
    ok: true,
    available: true,
    initialized: true,
    version: '0.9.4',
    warnings: [],
    ...overrides,
  });
}

function makeRunner(overrides: Partial<{ status: number | null; stdout: string; stderr: string; spawnError: string }> = {}): {
  runner: CodeGraphContextRunner;
  calls: Array<{ command: string; args: string[]; cwd: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: CodeGraphContextRunner = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (overrides.spawnError) return { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: overrides.spawnError };
    const status = overrides.status ?? 0;
    return {
      ok: status === 0,
      stdout: overrides.stdout ?? '# Context\nuse adapters/codegraph/codegraph_context.ts',
      stderr: overrides.stderr ?? '',
      exitCode: status,
    };
  };
  return { runner, calls };
}

describe('buildCodeGraphContext', () => {
  test('resolves npm .cmd shim target so task text can be passed as argv without cmd.exe quote loss', () => {
    const shim = [
      '@ECHO off',
      'SETLOCAL',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@colbymchenry\\codegraph\\npm-shim.js" %*',
    ].join('\n');

    expect(parseWindowsNpmShimTarget(shim, 'C:\\Users\\Martin\\AppData\\Roaming\\npm')).toBe(
      path.join('C:\\Users\\Martin\\AppData\\Roaming\\npm', 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js'),
    );
  });

  test('defaults to detect-only and does not call status or context/query commands', async () => {
    const { runner, calls } = makeRunner();
    let readinessCalls = 0;

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'use codegraph',
      mode: 'detect-only',
      runner,
      readinessProvider: async () => {
        readinessCalls += 1;
        return readyProvider()('/repo/root');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.mode).toBe('detect-only');
    expect(result.reason).toBe('DETECT_ONLY');
    expect(calls).toEqual([]);
    expect(readinessCalls).toBe(0);
  });

  test('use-existing ready path verifies status and runs bounded read-only context command', async () => {
    const { runner, calls } = makeRunner({ stdout: '# CodeGraph\nRelevant context' });

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'implement phase 2',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
      maxBytes: 4096,
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(true);
    expect(result.reason).toBe('EXISTING_INDEX');
    expect(result.outputText).toContain('Relevant context');
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['status', '--json']);
    expect(calls[1].args).toEqual([
      'context',
      'implement phase 2',
      '--path',
      '/repo/root',
      '--max-nodes',
      '50',
      '--max-code',
      '10',
      '--format',
      'markdown',
    ]);
    expect(calls[1].cwd).toBe('/repo/root');
  });

  test('use-existing not installed skips without running context', async () => {
    const { runner, calls } = makeRunner();

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider({ available: false, initialized: false }),
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.reason).toBe('CODEGRAPH_NOT_INSTALLED');
    expect(calls).toEqual([]);
  });

  test('use-existing not initialized skips without running init automatically', async () => {
    const { runner, calls } = makeRunner();

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider({ available: true, initialized: false }),
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.reason).toBe('CODEGRAPH_NOT_INITIALIZED');
    expect(calls.some((call) => call.args.includes('init'))).toBe(false);
    expect(calls.some((call) => call.args.includes('context') || call.args.includes('query'))).toBe(false);
  });

  test('stale index records a warning but still uses existing context without syncing or reindexing automatically', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const runner: CodeGraphContextRunner = (command, args, cwd) => {
      calls.push({ command, args: [...args], cwd });
      if (args[0] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 1, modified: 2, removed: 0 } }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { ok: true, stdout: '# Context\nExisting index context', stderr: '', exitCode: 0 };
    };

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(true);
    expect(result.reason).toBe('EXISTING_INDEX');
    expect(result.outputText).toContain('Existing index context');
    expect(result.warnings.some((warning) => warning.includes('CODEGRAPH_INDEX_STALE'))).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(['status', 'context']);
    expect(calls.some((call) => call.args.includes('sync') || call.args.includes('index'))).toBe(false);
  });

  test('command failure is recorded as skipped/fallback with bounded stderr', async () => {
    const longStderr = 'failure '.repeat(20_000);
    const { runner } = makeRunner({ status: 1, stdout: JSON.stringify({ initialized: true, pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: longStderr });

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
      maxBytes: 4096,
    });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(false);
    expect(result.reason).toBe('CODEGRAPH_STATUS_FAILED');
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
  });

  test('huge CodeGraph output is truncated and warning metadata records the bound', async () => {
    const huge = 'x'.repeat(100_000);
    const { runner } = makeRunner({ stdout: huge });

    const result = await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
      maxBytes: 4096,
    });

    expect(result.used).toBe(true);
    expect(result.outputText!.length).toBeLessThanOrEqual(4096);
    expect(result.warnings.some((warning) => warning.includes('CODEGRAPH_OUTPUT_TRUNCATED'))).toBe(true);
  });

  test('anti-scope: context build never runs init, index, sync, watch, serve, install, or agent config writes', async () => {
    const { runner, calls } = makeRunner();

    await buildCodeGraphContext({
      repoRoot: '/repo/root',
      task: 'task',
      mode: 'use-existing',
      runner,
      readinessProvider: readyProvider(),
    });

    const forbidden = new Set(['init', 'index', 'sync', 'watch', 'serve', 'install', 'uninstall']);
    for (const call of calls) {
      expect(call.args.some((arg) => forbidden.has(arg))).toBe(false);
    }
  });
});

describe('writeCodeGraphContextArtifacts', () => {
  test('writes usage metadata and context artifact when CodeGraph was used', () => {
    const { runDir } = tempRun();
    try {
      const result = {
        ok: true,
        used: true,
        mode: 'use-existing' as const,
        command: ['codegraph', 'context', 'task'],
        outputText: '# CodeGraph Context\nRelevant files',
        warnings: [],
        reason: 'EXISTING_INDEX',
      };

      const written = writeCodeGraphContextArtifacts({ runDir, result });

      expect(written.usageArtifact).toBe(path.join(runDir, 'scan', 'codegraph_usage.json'));
      expect(written.contextArtifact).toBe(path.join(runDir, 'scan', 'codegraph_context.md'));
      const usage = JSON.parse(fs.readFileSync(written.usageArtifact, 'utf8'));
      expect(usage).toMatchObject({ mode: 'use-existing', used: true, reason: 'EXISTING_INDEX', artifact: 'scan/codegraph_context.md' });
      expect(fs.readFileSync(written.contextArtifact!, 'utf8')).toContain('Relevant files');
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });

  test('skipped usage writes bounded metadata without creating a context artifact', () => {
    const { runDir } = tempRun();
    try {
      const written = writeCodeGraphContextArtifacts({
        runDir,
        result: {
          ok: true,
          used: false,
          mode: 'use-existing',
          reason: 'CODEGRAPH_NOT_INITIALIZED',
          warnings: ['initialize from GUI first'],
        },
      });

      expect(fs.existsSync(written.usageArtifact)).toBe(true);
      expect(written.contextArtifact).toBeUndefined();
      expect(fs.existsSync(path.join(runDir, 'scan', 'codegraph_context.md'))).toBe(false);
      const usage = JSON.parse(fs.readFileSync(written.usageArtifact, 'utf8'));
      expect(usage).toMatchObject({ mode: 'use-existing', used: false, reason: 'CODEGRAPH_NOT_INITIALIZED' });
    } finally {
      fs.rmSync(path.dirname(path.dirname(runDir)), { recursive: true, force: true });
    }
  });
});
