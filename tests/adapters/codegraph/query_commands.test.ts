import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  ALLOWED_QUERY_SUBCOMMANDS,
  runCodeGraphCallees,
  runCodeGraphCallers,
  runCodeGraphContextQuery,
  runCodeGraphFiles,
  runCodeGraphImpact,
  runCodeGraphSearch,
  type CodeGraphQueryRunner,
} from '../../../src/adapters/codegraph/codegraph_query_commands.js';

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-query-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  return repoRoot;
}

function makeInitializedRepo(): string {
  const repoRoot = makeRepo();
  fs.mkdirSync(path.join(repoRoot, '.codegraph'), { recursive: true });
  return repoRoot;
}

interface RunnerCall {
  command: string;
  args: string[];
  cwd: string;
}

function makeRunner(stdout: string, options: { ok?: boolean; stderr?: string } = {}): {
  runner: CodeGraphQueryRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: CodeGraphQueryRunner = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    const ok = options.ok ?? true;
    return { ok, stdout, stderr: options.stderr ?? '', exitCode: ok ? 0 : 1 };
  };
  return { runner, calls };
}

function alwaysAvailable() {
  return () => ({ found: true, version: 'test' }) as const;
}

function alwaysInitialized() {
  return () => true;
}

describe('codegraph query commands adapter', () => {
  test('search wraps codegraph query with --path/--limit/--json', () => {
    const repoRoot = makeInitializedRepo();
    const { runner, calls } = makeRunner('[{"node":{"name":"foo"}}]');
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'desktop settings',
      maxResults: 5,
      json: true,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['query', '--path', repoRoot, 'desktop settings', '--limit', '5', '--json']);
    expect(result.ok).toBe(true);
    expect(result.parsedJson).toEqual([{ node: { name: 'foo' } }]);
    expect(result.command).toEqual(['codegraph', 'query', '--path', repoRoot, 'desktop settings', '--limit', '5', '--json']);
    expect(result.warnings).toEqual([]);
  });

  test('context wraps codegraph context with --max-nodes/--max-code and --format json', () => {
    const repoRoot = makeInitializedRepo();
    const { runner, calls } = makeRunner('{"context":"ok"}');
    const result = runCodeGraphContextQuery({
      repoRoot,
      query: 'auth refactor',
      maxNodes: 30,
      maxCode: 8,
      json: true,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });

    expect(calls[0]!.args).toEqual([
      'context',
      '--path',
      repoRoot,
      'auth refactor',
      '--max-nodes',
      '30',
      '--max-code',
      '8',
      '--format',
      'json',
    ]);
    expect(result.ok).toBe(true);
    expect(result.parsedJson).toEqual({ context: 'ok' });
  });

  test('files passes --json and applies local limit on parsed JSON arrays', () => {
    const repoRoot = makeInitializedRepo();
    const arr = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts` }));
    const { runner } = makeRunner(JSON.stringify(arr));
    const result = runCodeGraphFiles({
      repoRoot,
      json: true,
      limit: 3,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.parsedJson)).toBe(true);
    expect((result.parsedJson as unknown[]).length).toBe(3);
    expect(result.warnings.some((w) => w.includes('CODEGRAPH_FILES_TRUNCATED'))).toBe(true);
  });

  test('callers and callees wrap their upstream subcommands', () => {
    const repoRoot = makeInitializedRepo();
    {
      const { runner, calls } = makeRunner('[]');
      runCodeGraphCallers({
        repoRoot,
        symbol: 'fooBar',
        limit: 12,
        json: true,
        runner,
        versionProbe: alwaysAvailable(),
        initializedProbe: alwaysInitialized(),
      });
      expect(calls[0]!.args).toEqual(['callers', '--path', repoRoot, 'fooBar', '--limit', '12', '--json']);
    }
    {
      const { runner, calls } = makeRunner('[]');
      runCodeGraphCallees({
        repoRoot,
        symbol: 'fooBar',
        runner,
        versionProbe: alwaysAvailable(),
        initializedProbe: alwaysInitialized(),
      });
      expect(calls[0]!.args).toEqual(['callees', '--path', repoRoot, 'fooBar']);
    }
  });

  test('impact maps --limit to upstream --depth', () => {
    const repoRoot = makeInitializedRepo();
    const { runner, calls } = makeRunner('{}');
    runCodeGraphImpact({
      repoRoot,
      symbol: 'src/lib.ts',
      limit: 4,
      json: true,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(calls[0]!.args).toEqual(['impact', '--path', repoRoot, 'src/lib.ts', '--depth', '4', '--json']);
  });

  test('returns CODEGRAPH_NOT_INSTALLED when probe reports missing', () => {
    const repoRoot = makeInitializedRepo();
    const runnerCalls: RunnerCall[] = [];
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      versionProbe: () => ({ found: false, warning: 'ENOENT' }),
      initializedProbe: alwaysInitialized(),
      runner: (cmd, args, cwd) => {
        runnerCalls.push({ command: cmd, args: [...args], cwd });
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CODEGRAPH_NOT_INSTALLED');
    expect(runnerCalls).toHaveLength(0);
  });

  test('returns CODEGRAPH_NOT_INITIALIZED and does not spawn runner', () => {
    const repoRoot = makeRepo();
    const runnerCalls: RunnerCall[] = [];
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      versionProbe: alwaysAvailable(),
      initializedProbe: () => false,
      runner: (cmd, args, cwd) => {
        runnerCalls.push({ command: cmd, args: [...args], cwd });
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CODEGRAPH_NOT_INITIALIZED');
    expect(result.error?.message).toContain('vibecode codegraph init');
    expect(runnerCalls).toHaveLength(0);
  });

  test('anti-scope: never invokes init/sync/index/watch/serve subcommands', () => {
    const forbidden = ['init', 'sync', 'index', 'watch', 'serve', 'uninit'];
    const allowed = Array.from(ALLOWED_QUERY_SUBCOMMANDS);
    for (const f of forbidden) {
      expect(allowed.includes(f)).toBe(false);
    }
    const repoRoot = makeInitializedRepo();
    const seenSubcommands: string[] = [];
    const runner: CodeGraphQueryRunner = (_cmd, args) => {
      seenSubcommands.push(args[0]!);
      return { ok: true, stdout: '', stderr: '', exitCode: 0 };
    };
    const calls = [
      () => runCodeGraphSearch({ repoRoot, query: 'x', runner, versionProbe: alwaysAvailable(), initializedProbe: alwaysInitialized() }),
      () => runCodeGraphContextQuery({ repoRoot, query: 'x', runner, versionProbe: alwaysAvailable(), initializedProbe: alwaysInitialized() }),
      () => runCodeGraphFiles({ repoRoot, runner, versionProbe: alwaysAvailable(), initializedProbe: alwaysInitialized() }),
      () => runCodeGraphCallers({ repoRoot, symbol: 'x', runner, versionProbe: alwaysAvailable(), initializedProbe: alwaysInitialized() }),
      () => runCodeGraphCallees({ repoRoot, symbol: 'x', runner, versionProbe: alwaysAvailable(), initializedProbe: alwaysInitialized() }),
      () => runCodeGraphImpact({ repoRoot, symbol: 'x', runner, versionProbe: alwaysAvailable(), initializedProbe: alwaysInitialized() }),
    ];
    for (const c of calls) c();
    for (const subcommand of seenSubcommands) {
      expect(ALLOWED_QUERY_SUBCOMMANDS.has(subcommand)).toBe(true);
      expect(forbidden.includes(subcommand)).toBe(false);
    }
  });

  test('does not create .codegraph/ or any other files', () => {
    const repoRoot = makeRepo();
    const before = fs.readdirSync(repoRoot).sort();
    const { runner } = makeRunner('');
    runCodeGraphSearch({
      repoRoot,
      query: 'x',
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: () => false,
    });
    const after = fs.readdirSync(repoRoot).sort();
    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(repoRoot, '.codegraph'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.vibecode'))).toBe(false);
  });

  test('reports CODEGRAPH_QUERY_FAILED on non-zero exit and surfaces stderr', () => {
    const repoRoot = makeInitializedRepo();
    const { runner } = makeRunner('', { ok: false, stderr: 'index lock contention' });
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CODEGRAPH_QUERY_FAILED');
    expect(result.error?.message).toContain('index lock contention');
  });

  test('rejects empty query/symbol with INVALID_ARGUMENT and no spawn', () => {
    const repoRoot = makeInitializedRepo();
    const runnerCalls: RunnerCall[] = [];
    const runner: CodeGraphQueryRunner = (cmd, args, cwd) => {
      runnerCalls.push({ command: cmd, args: [...args], cwd });
      return { ok: true, stdout: '', stderr: '', exitCode: 0 };
    };
    const probe = { versionProbe: alwaysAvailable(), initializedProbe: alwaysInitialized(), runner };
    const r1 = runCodeGraphSearch({ repoRoot, query: '  ', ...probe });
    const r2 = runCodeGraphCallers({ repoRoot, symbol: '', ...probe });
    expect(r1.error?.code).toBe('INVALID_ARGUMENT');
    expect(r2.error?.code).toBe('INVALID_ARGUMENT');
    expect(runnerCalls).toHaveLength(0);
  });

  test('rejects non-positive --max-results', () => {
    const repoRoot = makeInitializedRepo();
    const { runner } = makeRunner('');
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      maxResults: 0,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
  });
});
