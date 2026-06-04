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
import type { CodeGraphBinarySource } from './codegraph_binary_resolver.js';

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
  /** Set when the failure relates to binary resolution (CODEGRAPH_NOT_INSTALLED). */
  attempted_binary?: string;
  binary_source?: CodeGraphBinarySource;
  /** Free-form hint shown to operators. */
  hint?: string;
}

/**
 * Schema metadata describing how the upstream CodeGraph `query` score should
 * be interpreted. The upstream score is an unbounded query-relative ranking
 * score — not a probability, confidence, or percentage. Vibecode surfaces this
 * metadata so agents and downstream consumers do not misread the number.
 */
export interface CodeGraphScoreMeta {
  score_kind: 'raw_upstream_rank_score';
  score_is_percentage: false;
  score_scope: 'query_relative';
  /** Largest raw upstream score observed in this result set, or null. */
  max_score: number | null;
  note: string;
}

export interface CodeGraphQueryResult {
  ok: boolean;
  command: string[];
  repoRoot: string;
  stdoutText?: string;
  parsedJson?: unknown;
  warnings: string[];
  error?: CodeGraphQueryError;
  /** Search-specific score metadata (set by runCodeGraphSearch only). */
  scoreMeta?: CodeGraphScoreMeta;
}

export interface CodeGraphQueryCommonOptions {
  repoRoot: string;
  json?: boolean;
  timeoutMs?: number;
  /** Override codegraph command name (defaults to `codegraph`). */
  command?: string;
  /**
   * Where the resolved binary came from. Used for diagnostics on
   * CODEGRAPH_NOT_INSTALLED errors and log events. Defaults to PATH_FALLBACK.
   */
  binarySource?: CodeGraphBinarySource;
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
  const attempted = opts.command ?? CODEGRAPH_COMMAND;
  const source: CodeGraphBinarySource = opts.binarySource ?? 'PATH_FALLBACK';
  return {
    ok: false,
    command: [attempted, subcommand],
    repoRoot: opts.repoRoot,
    warnings: [],
    error: {
      code: 'CODEGRAPH_NOT_INSTALLED',
      message:
        `codegraph command not found (attempted: ${attempted}, source: ${source}). ` +
        'Set VIBECODE_CODEGRAPH_BIN or run `vibecode codegraph binary set <path>`, ' +
        'then verify with `vibecode codegraph status --repo <path>`.',
      attempted_binary: attempted,
      binary_source: source,
      hint: 'Set VIBECODE_CODEGRAPH_BIN or run `vibecode codegraph binary set <path>`.',
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

/**
 * Strip upstream percentage-formatted score annotations like `(2872%)` so that
 * unbounded raw rank scores are not surfaced as misleading percentages. Used
 * as a defensive fallback when JSON parsing fails.
 */
function stripUpstreamPercentScores(text: string): string {
  return text.replace(/\s*\(\d+(?:\.\d+)?%\)/g, '');
}

function extractScore(item: unknown): number | null {
  if (item && typeof item === 'object' && 'score' in (item as Record<string, unknown>)) {
    const v = (item as Record<string, unknown>).score;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return null;
}

function computeMaxScore(items: unknown[]): number | null {
  let max: number | null = null;
  for (const it of items) {
    const s = extractScore(it);
    if (s === null) continue;
    if (max === null || s > max) max = s;
  }
  return max;
}

const SCORE_NOTE =
  'score is the upstream CodeGraph raw rank score: query-relative, not a percentage';

function enrichSearchResult(
  item: unknown,
  rank: number,
  maxScore: number | null,
): unknown {
  if (!item || typeof item !== 'object') return item;
  const score = extractScore(item);
  if (score === null) return item;
  const enriched: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  enriched.rank = rank;
  enriched.raw_score = score;
  if (maxScore !== null && maxScore > 0) {
    enriched.relative_score = score / maxScore;
  }
  enriched.score_kind = 'raw_upstream_rank_score';
  enriched.score_is_percentage = false;
  enriched.score_scope = 'query_relative';
  return enriched;
}

interface NormalizedSearch {
  parsedJson: unknown;
  results: unknown[];
  maxScore: number | null;
}

function normalizeSearchPayload(parsedJson: unknown): NormalizedSearch {
  if (Array.isArray(parsedJson)) {
    const maxScore = computeMaxScore(parsedJson);
    const enriched = parsedJson.map((r, i) => enrichSearchResult(r, i + 1, maxScore));
    return { parsedJson: enriched, results: enriched, maxScore };
  }
  if (
    parsedJson &&
    typeof parsedJson === 'object' &&
    Array.isArray((parsedJson as { results?: unknown }).results)
  ) {
    const arr = (parsedJson as { results: unknown[] }).results;
    const maxScore = computeMaxScore(arr);
    const enriched = arr.map((r, i) => enrichSearchResult(r, i + 1, maxScore));
    return {
      parsedJson: { ...(parsedJson as Record<string, unknown>), results: enriched },
      results: enriched,
      maxScore,
    };
  }
  return { parsedJson, results: [], maxScore: null };
}

function readField(obj: unknown, keys: string[]): string | number | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function renderSearchText(results: unknown[]): string {
  if (results.length === 0) return '';
  const lines: string[] = [];
  lines.push(`Note: ${SCORE_NOTE}.`);
  lines.push('');
  for (const r of results) {
    const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const node = rec.node && typeof rec.node === 'object' ? (rec.node as Record<string, unknown>) : null;
    const kind = node ? readField(node, ['kind', 'node_kind', 'type']) : readField(rec, ['kind', 'node_kind', 'type']);
    const name = node ? readField(node, ['name', 'symbol', 'id']) : readField(rec, ['name', 'symbol', 'id']);
    const file = node ? readField(node, ['path', 'file', 'file_path']) : readField(rec, ['path', 'file', 'file_path']);
    const line = node ? readField(node, ['start_line', 'line', 'line_number']) : readField(rec, ['start_line', 'line', 'line_number']);
    const rank = rec.rank;
    const raw = rec.raw_score;
    const rel = rec.relative_score;

    const headParts: string[] = [];
    headParts.push(`${typeof rank === 'number' ? rank : '?'}.`);
    if (kind) headParts.push(`[${kind}]`);
    if (name) headParts.push(String(name));
    if (file) headParts.push(line ? `(${file}:${line})` : `(${file})`);
    if (headParts.length === 1) headParts.push('(no node metadata)');
    lines.push(headParts.join(' '));

    const scoreParts: string[] = [];
    if (typeof raw === 'number') scoreParts.push(`raw_score=${raw.toFixed(2)}`);
    if (typeof rel === 'number') scoreParts.push(`relative_score=${rel.toFixed(3)}`);
    if (scoreParts.length > 0) lines.push(`   ${scoreParts.join(' ')}`);
  }
  return lines.join('\n');
}

/** vibecode codegraph search — wraps `codegraph query`. */
export function runCodeGraphSearch(options: CodeGraphSearchOptions): CodeGraphQueryResult {
  if (!options.query || !options.query.trim()) {
    return invalidArgResult(options, 'query', 'search query is required');
  }
  const valid = validatePositiveInteger(options.maxResults, '--max-results');
  if (!valid.ok) return invalidArgResult(options, 'query', valid.message);

  // Always request JSON from upstream so Vibecode renders its own scores.
  // Upstream's text renderer multiplies the unbounded raw rank score by 100
  // and appends `%`, which is misleading. By driving from JSON we never print
  // those upstream percentage strings.
  const args = [...buildPathArgs(path.resolve(options.repoRoot)), options.query];
  if (options.maxResults !== undefined) args.push('--limit', String(options.maxResults));
  args.push('--json');
  const result = executeQuery({ ...options, json: true }, 'query', args);
  if (!result.ok) {
    if (result.stdoutText) result.stdoutText = stripUpstreamPercentScores(result.stdoutText);
    return result;
  }

  const normalized = normalizeSearchPayload(result.parsedJson);
  result.parsedJson = normalized.parsedJson;
  result.scoreMeta = {
    score_kind: 'raw_upstream_rank_score',
    score_is_percentage: false,
    score_scope: 'query_relative',
    max_score: normalized.maxScore,
    note: SCORE_NOTE,
  };

  if (!options.json) {
    // For text-mode callers, replace upstream stdout with Vibecode's own
    // rendering driven by parsed JSON. Falls back to a sanitized upstream
    // string (with `(NN%)` annotations stripped) if parsing failed.
    if (normalized.results.length > 0 || result.parsedJson !== undefined) {
      result.stdoutText = renderSearchText(normalized.results);
    } else if (result.stdoutText) {
      result.stdoutText = stripUpstreamPercentScores(result.stdoutText);
    }
  }
  return result;
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
