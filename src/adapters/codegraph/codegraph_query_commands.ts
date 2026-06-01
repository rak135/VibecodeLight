import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import {
  CODEGRAPH_COMMAND,
  CODEGRAPH_DIR_NAME,
  defaultVersionProbe,
  type CodeGraphVersionProbe,
} from './codegraph_cli.js';
import type {
  CodeGraphActionRunner,
  CodeGraphRunResult,
} from './codegraph_actions.js';

/**
 * Provider-agnostic read-only CodeGraph query commands exposed as shell tools
 * for any terminal agent. These wrap a subset of the upstream `codegraph`
 * binary that is verified to exist and is purely read-only.
 *
 * Hard rules (anti-scope):
 *  - never run init/sync/index/watch/serve
 *  - never create .codegraph/
 *  - never mutate the repository
 *  - never call an LLM provider
 *
 * Only the upstream subcommands enumerated in ALLOWED_QUERY_SUBCOMMANDS may
 * ever be passed to the runner. Anything else is a programmer error.
 */

export const ALLOWED_QUERY_SUBCOMMANDS = new Set([
  'query',
  'context',
  'files',
  'callers',
  'callees',
  'impact',
]);

export type CodeGraphQueryRunner = CodeGraphActionRunner;

export interface CodeGraphQueryError {
  code: string;
  message: string;
}

export interface CodeGraphQueryResult {
  ok: boolean;
  command: string[];
  repoRoot: string;
  stdoutText?: string;
  parsedJson?: unknown;
  warnings: string[];
  error?: CodeGraphQueryError;
}

export interface CodeGraphQueryCommonOptions {
  repoRoot: string;
  json?: boolean;
  timeoutMs?: number;
  /** Override codegraph command name (defaults to `codegraph`). */
  command?: string;
  /** Override runner for tests. */
  runner?: CodeGraphQueryRunner;
  /** Override the availability probe for tests. */
  versionProbe?: CodeGraphVersionProbe;
  /** Override the .codegraph initialization check for tests. */
  initializedProbe?: (repoRoot: string) => boolean;
}

export interface CodeGraphSearchOptions extends CodeGraphQueryCommonOptions {
  query: string;
  maxResults?: number;
}

export interface CodeGraphContextOptions extends CodeGraphQueryCommonOptions {
  query: string;
  maxNodes?: number;
  maxCode?: number;
}

export interface CodeGraphFilesOptions extends CodeGraphQueryCommonOptions {
  /** Optional local cap on number of file entries returned in --json output. */
  limit?: number;
}

export interface CodeGraphSymbolOptions extends CodeGraphQueryCommonOptions {
  symbol: string;
  limit?: number;
}

export interface CodeGraphImpactOptions extends CodeGraphQueryCommonOptions {
  symbol: string;
  /** Maps to upstream `-d/--depth`. */
  limit?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 4_000;

function bound(s: string): string {
  if (s.length <= OUTPUT_LIMIT) return s;
  return s.slice(0, OUTPUT_LIMIT - 3) + '...';
}

function defaultRunner(timeoutMs: number): CodeGraphQueryRunner {
  return (command, args, cwd): CodeGraphRunResult => {
    const candidates =
      process.platform === 'win32' && !path.extname(command)
        ? [`${command}.cmd`, command]
        : [command];

    let lastResult: CodeGraphRunResult = { ok: false, stdout: '', stderr: '', exitCode: null };

    for (const candidate of candidates) {
      let raw: ReturnType<typeof spawnSync>;
      if (process.platform === 'win32' && path.extname(candidate).toLowerCase() === '.cmd') {
        // Spawn .cmd shims through cmd.exe with manually quoted args; bypass
        // Node's argv quoting (which would otherwise re-wrap our quotes) by
        // using windowsVerbatimArguments.
        const shell = process.env.ComSpec ?? 'cmd.exe';
        const quoted = args
          .map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
          .join(' ');
        raw = spawnSync(shell, ['/d', '/s', '/c', `${candidate} ${quoted}`], {
          encoding: 'utf8',
          timeout: timeoutMs,
          cwd,
          windowsVerbatimArguments: true,
        });
      } else {
        raw = spawnSync(candidate, args, { encoding: 'utf8', timeout: timeoutMs, cwd });
      }

      if (raw.error) {
        const msg = raw.error.message ?? String(raw.error);
        if (candidates.length > 1 && /ENOENT/i.test(msg) && candidate !== candidates[candidates.length - 1]) {
          lastResult = { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: msg };
          continue;
        }
        return { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: msg };
      }

      const stdout = typeof raw.stdout === 'string' ? raw.stdout : (raw.stdout?.toString() ?? '');
      const stderr = typeof raw.stderr === 'string' ? raw.stderr : (raw.stderr?.toString() ?? '');
      const exitCode = raw.status ?? null;
      return { ok: exitCode === 0, stdout, stderr, exitCode };
    }
    return lastResult;
  };
}

function isInitialized(repoRoot: string, probe?: (repoRoot: string) => boolean): boolean {
  if (probe) return probe(repoRoot);
  try {
    const dir = path.join(repoRoot, CODEGRAPH_DIR_NAME);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isAvailable(command: string, probe?: CodeGraphVersionProbe): boolean {
  try {
    const result = (probe ?? defaultVersionProbe)(command);
    return result.found;
  } catch {
    return false;
  }
}

function notInstalledResult(opts: CodeGraphQueryCommonOptions, subcommand: string): CodeGraphQueryResult {
  return {
    ok: false,
    command: [opts.command ?? CODEGRAPH_COMMAND, subcommand],
    repoRoot: opts.repoRoot,
    warnings: [],
    error: {
      code: 'CODEGRAPH_NOT_INSTALLED',
      message:
        'codegraph command not found. Install CodeGraph and verify with `vibecode codegraph status --repo <path>`.',
    },
  };
}

function notInitializedResult(opts: CodeGraphQueryCommonOptions, subcommand: string): CodeGraphQueryResult {
  return {
    ok: false,
    command: [opts.command ?? CODEGRAPH_COMMAND, subcommand],
    repoRoot: opts.repoRoot,
    warnings: [],
    error: {
      code: 'CODEGRAPH_NOT_INITIALIZED',
      message:
        `CodeGraph index not initialized at ${opts.repoRoot}. Run \`vibecode codegraph init --repo ${opts.repoRoot}\` first.`,
    },
  };
}

function invalidArgResult(opts: CodeGraphQueryCommonOptions, subcommand: string, message: string): CodeGraphQueryResult {
  return {
    ok: false,
    command: [opts.command ?? CODEGRAPH_COMMAND, subcommand],
    repoRoot: opts.repoRoot,
    warnings: [],
    error: { code: 'INVALID_ARGUMENT', message },
  };
}

function parseJsonIfRequested(json: boolean | undefined, stdout: string, warnings: string[]): unknown {
  if (!json) return undefined;
  if (!stdout.trim()) return undefined;
  try {
    return JSON.parse(stdout);
  } catch (err) {
    warnings.push(`CODEGRAPH_JSON_PARSE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function executeQuery(
  opts: CodeGraphQueryCommonOptions,
  subcommand: string,
  upstreamArgs: string[],
): CodeGraphQueryResult {
  if (!ALLOWED_QUERY_SUBCOMMANDS.has(subcommand)) {
    return {
      ok: false,
      command: [opts.command ?? CODEGRAPH_COMMAND, subcommand],
      repoRoot: opts.repoRoot,
      warnings: [],
      error: {
        code: 'CODEGRAPH_DISALLOWED_SUBCOMMAND',
        message: `subcommand not allowed for read-only query: ${subcommand}`,
      },
    };
  }

  const command = opts.command ?? CODEGRAPH_COMMAND;
  const repoRoot = path.resolve(opts.repoRoot);

  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    return {
      ok: false,
      command: [command, subcommand],
      repoRoot,
      warnings: [],
      error: {
        code: 'INVALID_REPO_PATH',
        message: `repository path not found or not a directory: ${repoRoot}`,
      },
    };
  }

  if (!isAvailable(command, opts.versionProbe)) {
    return notInstalledResult({ ...opts, repoRoot }, subcommand);
  }

  if (!isInitialized(repoRoot, opts.initializedProbe)) {
    return notInitializedResult({ ...opts, repoRoot }, subcommand);
  }

  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const runner = opts.runner ?? defaultRunner(timeoutMs);
  const fullArgs = [subcommand, ...upstreamArgs];
  const warnings: string[] = [];

  const run = runner(command, fullArgs, repoRoot);
  const stdout = bound(run.stdout ?? '');
  const stderr = (run.stderr ?? '').trim();

  if (!run.ok) {
    const errorMessage = run.spawnError
      ? `codegraph spawn failed: ${run.spawnError}`
      : stderr
      ? stderr.split(/\r?\n/)[0]?.slice(0, 200) ?? 'codegraph command failed'
      : run.exitCode !== null
      ? `codegraph exited with code ${run.exitCode}`
      : 'codegraph command failed';
    return {
      ok: false,
      command: [command, ...fullArgs],
      repoRoot,
      stdoutText: stdout || undefined,
      warnings,
      error: {
        code: 'CODEGRAPH_QUERY_FAILED',
        message: errorMessage,
      },
    };
  }

  const parsedJson = parseJsonIfRequested(opts.json, run.stdout ?? '', warnings);
  if (stderr) warnings.push(`CODEGRAPH_STDERR: ${stderr.split(/\r?\n/)[0]?.slice(0, 200) ?? ''}`);

  return {
    ok: true,
    command: [command, ...fullArgs],
    repoRoot,
    stdoutText: stdout,
    parsedJson,
    warnings,
  };
}

function buildPathArgs(repoRoot: string): string[] {
  return ['--path', repoRoot];
}

function validatePositiveInteger(value: number | undefined, label: string): { ok: true } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `invalid ${label}: expected a positive integer (got ${value})` };
  }
  return { ok: true };
}

/** vibecode codegraph search — wraps `codegraph query`. */
export function runCodeGraphSearch(options: CodeGraphSearchOptions): CodeGraphQueryResult {
  if (!options.query || !options.query.trim()) {
    return invalidArgResult(options, 'query', 'search query is required');
  }
  const valid = validatePositiveInteger(options.maxResults, '--max-results');
  if (!valid.ok) return invalidArgResult(options, 'query', valid.message);

  const args = [...buildPathArgs(path.resolve(options.repoRoot)), options.query];
  if (options.maxResults !== undefined) args.push('--limit', String(options.maxResults));
  if (options.json) args.push('--json');
  return executeQuery(options, 'query', args);
}

/** vibecode codegraph context — wraps `codegraph context`. */
export function runCodeGraphContextQuery(options: CodeGraphContextOptions): CodeGraphQueryResult {
  if (!options.query || !options.query.trim()) {
    return invalidArgResult(options, 'context', 'context query is required');
  }
  let v = validatePositiveInteger(options.maxNodes, '--max-nodes');
  if (!v.ok) return invalidArgResult(options, 'context', v.message);
  v = validatePositiveInteger(options.maxCode, '--max-code');
  if (!v.ok) return invalidArgResult(options, 'context', v.message);

  const args = [...buildPathArgs(path.resolve(options.repoRoot)), options.query];
  if (options.maxNodes !== undefined) args.push('--max-nodes', String(options.maxNodes));
  if (options.maxCode !== undefined) args.push('--max-code', String(options.maxCode));
  if (options.json) args.push('--format', 'json');
  return executeQuery(options, 'context', args);
}

/** vibecode codegraph files — wraps `codegraph files`. */
export function runCodeGraphFiles(options: CodeGraphFilesOptions): CodeGraphQueryResult {
  const valid = validatePositiveInteger(options.limit, '--limit');
  if (!valid.ok) return invalidArgResult(options, 'files', valid.message);

  const args = [...buildPathArgs(path.resolve(options.repoRoot))];
  if (options.json) args.push('--json');
  const result = executeQuery(options, 'files', args);
  // Optional local cap on parsed JSON output.
  if (result.ok && options.json && options.limit && Array.isArray(result.parsedJson)) {
    if (result.parsedJson.length > options.limit) {
      result.warnings.push(`CODEGRAPH_FILES_TRUNCATED: limited from ${result.parsedJson.length} to ${options.limit} entries`);
      result.parsedJson = result.parsedJson.slice(0, options.limit);
    }
  }
  return result;
}

/** vibecode codegraph callers — wraps `codegraph callers`. */
export function runCodeGraphCallers(options: CodeGraphSymbolOptions): CodeGraphQueryResult {
  if (!options.symbol || !options.symbol.trim()) {
    return invalidArgResult(options, 'callers', 'symbol is required');
  }
  const valid = validatePositiveInteger(options.limit, '--limit');
  if (!valid.ok) return invalidArgResult(options, 'callers', valid.message);

  const args = [...buildPathArgs(path.resolve(options.repoRoot)), options.symbol];
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  if (options.json) args.push('--json');
  return executeQuery(options, 'callers', args);
}

/** vibecode codegraph callees — wraps `codegraph callees`. */
export function runCodeGraphCallees(options: CodeGraphSymbolOptions): CodeGraphQueryResult {
  if (!options.symbol || !options.symbol.trim()) {
    return invalidArgResult(options, 'callees', 'symbol is required');
  }
  const valid = validatePositiveInteger(options.limit, '--limit');
  if (!valid.ok) return invalidArgResult(options, 'callees', valid.message);

  const args = [...buildPathArgs(path.resolve(options.repoRoot)), options.symbol];
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  if (options.json) args.push('--json');
  return executeQuery(options, 'callees', args);
}

/** vibecode codegraph impact — wraps `codegraph impact`. */
export function runCodeGraphImpact(options: CodeGraphImpactOptions): CodeGraphQueryResult {
  if (!options.symbol || !options.symbol.trim()) {
    return invalidArgResult(options, 'impact', 'symbol or path is required');
  }
  const valid = validatePositiveInteger(options.limit, '--limit');
  if (!valid.ok) return invalidArgResult(options, 'impact', valid.message);

  const args = [...buildPathArgs(path.resolve(options.repoRoot)), options.symbol];
  if (options.limit !== undefined) args.push('--depth', String(options.limit));
  if (options.json) args.push('--json');
  return executeQuery(options, 'impact', args);
}
