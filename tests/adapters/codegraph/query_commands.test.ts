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

  test('search always invokes upstream with --json regardless of caller json flag', () => {
    const repoRoot = makeInitializedRepo();
    const { runner, calls } = makeRunner('[]');
    runCodeGraphSearch({
      repoRoot,
      query: 'x',
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe('--json');
  });

  test('search renders its own text from parsed JSON (no upstream percentages)', () => {
    const repoRoot = makeInitializedRepo();
    const upstream = JSON.stringify([
      { node: { name: 'fooFn', kind: 'function', path: 'src/foo.ts', start_line: 10 }, score: 28.71846336436746 },
      { node: { name: 'barFn', kind: 'function', path: 'src/bar.ts', start_line: 22 }, score: 14.3 },
    ]);
    const { runner } = makeRunner(upstream);
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(result.ok).toBe(true);
    expect(result.stdoutText).toBeDefined();
    // No `%` anywhere in text output, and no upstream `(2872%)` rendering.
    expect(result.stdoutText!).not.toContain('%');
    expect(result.stdoutText!).not.toContain('2872');
    // Contains the raw score (rounded), labels score as query-relative.
    expect(result.stdoutText!).toContain('raw_score=28.72');
    expect(result.stdoutText!.toLowerCase()).toContain('query-relative');
    expect(result.stdoutText!.toLowerCase()).toContain('not a percentage');
  });

  test('search does not render raw 100.73 as 10073% in text', () => {
    const repoRoot = makeInitializedRepo();
    const upstream = JSON.stringify([
      { node: { name: 'topFn', path: 'src/top.ts' }, score: 100.73 },
    ]);
    const { runner } = makeRunner(upstream);
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(result.ok).toBe(true);
    expect(result.stdoutText!).not.toContain('10073');
    expect(result.stdoutText!).not.toContain('%');
    expect(result.stdoutText!).toContain('raw_score=100.73');
  });

  test('search JSON envelope preserves raw upstream score and adds enrichment fields', () => {
    const repoRoot = makeInitializedRepo();
    const upstream = JSON.stringify([
      { node: { name: 'a' }, score: 20 },
      { node: { name: 'b' }, score: 5 },
    ]);
    const { runner } = makeRunner(upstream);
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      json: true,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(result.ok).toBe(true);
    const arr = result.parsedJson as Array<Record<string, unknown>>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(2);
    // Original `score` preserved
    expect(arr[0]!.score).toBe(20);
    expect(arr[1]!.score).toBe(5);
    // Enrichment fields
    expect(arr[0]!.raw_score).toBe(20);
    expect(arr[0]!.score_kind).toBe('raw_upstream_rank_score');
    expect(arr[0]!.score_is_percentage).toBe(false);
    expect(arr[0]!.score_scope).toBe('query_relative');
    expect(arr[0]!.rank).toBe(1);
    expect(arr[1]!.rank).toBe(2);
    // Relative score is relative to top score in this result set
    expect(arr[0]!.relative_score).toBe(1);
    expect(arr[1]!.relative_score).toBeCloseTo(0.25, 5);
  });

  test('search exposes scoreMeta envelope with max_score and non-percentage flags', () => {
    const repoRoot = makeInitializedRepo();
    const upstream = JSON.stringify([{ node: {}, score: 42.5 }]);
    const { runner } = makeRunner(upstream);
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      json: true,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(result.scoreMeta).toMatchObject({
      score_kind: 'raw_upstream_rank_score',
      score_is_percentage: false,
      score_scope: 'query_relative',
      max_score: 42.5,
    });
  });

  test('search leaves results without a numeric score untouched', () => {
    const repoRoot = makeInitializedRepo();
    const { runner } = makeRunner('[{"node":{"name":"foo"}}]');
    const result = runCodeGraphSearch({
      repoRoot,
      query: 'x',
      json: true,
      runner,
      versionProbe: alwaysAvailable(),
      initializedProbe: alwaysInitialized(),
    });
    expect(result.parsedJson).toEqual([{ node: { name: 'foo' } }]);
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
