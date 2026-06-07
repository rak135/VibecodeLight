import fs from 'fs';
import path from 'path';

import { LlmAdapterError } from '../llm/errors.js';
import { resolveExplicitRunDir } from '../../core/runs/run_resolver.js';

/**
 * Append-only JSONL logger for agent-facing CodeGraph query commands.
 *
 * Logs land under `<repo>/.vibecode/` only:
 *   - workspace-level: `.vibecode/logs/codegraph_queries.jsonl`
 *   - run-scoped:      `.vibecode/runs/<run_id>/terminal/codegraph_queries.jsonl`
 *
 * Hard rules:
 *  - never create a run directory we did not already find
 *  - never log full stdout/stderr; only byte counts and bounded metadata
 *  - never throw from logging — return warnings instead
 *  - never write outside `.vibecode/logs` or `.vibecode/runs/<run_id>/terminal`
 */

export const CODEGRAPH_QUERY_LOG_SCHEMA_VERSION = 1;

export type CodeGraphQuerySubcommand =
  | 'search'
  | 'context'
  | 'files'
  | 'callers'
  | 'callees'
  | 'impact';

export interface CodeGraphQueryLogInput {
  query?: string;
  symbol?: string;
  path_or_symbol?: string;
  limit?: number;
  max_results?: number;
  max_nodes?: number;
  max_code?: number;
}

export interface CodeGraphQueryLogResultSummary {
  stdout_bytes: number;
  stderr_bytes: number;
  parsed_json: boolean;
  items: number | null;
  truncated: boolean;
}

export interface CodeGraphQueryLogError {
  code: string;
  message: string;
  /** Attempted upstream binary path when the failure relates to binary resolution. */
  attempted_binary?: string;
  /** Source label of the attempted binary (e.g. CLI_OPTION, GLOBAL_CONFIG). */
  binary_source?: string;
}

export interface CodeGraphQueryLogEvent {
  schema_version: typeof CODEGRAPH_QUERY_LOG_SCHEMA_VERSION;
  timestamp: string;
  run_id: string | null;
  tool: 'codegraph';
  subcommand: CodeGraphQuerySubcommand;
  repo_root: string;
  command: string[];
  input: CodeGraphQueryLogInput;
  ok: boolean;
  exit_code: number | null;
  duration_ms: number;
  warnings: string[];
  error: CodeGraphQueryLogError | null;
  result_summary: CodeGraphQueryLogResultSummary;
}

export interface CodeGraphLogPaths {
  workspaceLog: string;
  runLog: string | null;
}

export interface CodeGraphQueryLogWriteResult {
  workspaceLogWritten: boolean;
  runLogWritten: boolean;
  warnings: string[];
  workspaceLogPath: string;
  runLogPath: string | null;
}

export function resolveCodeGraphLogPaths(repoRoot: string, runId?: string | null): CodeGraphLogPaths {
  const workspaceLog = path.join(repoRoot, '.vibecode', 'logs', 'codegraph_queries.jsonl');
  const runLog = runId
    ? path.join(repoRoot, '.vibecode', 'runs', runId, 'terminal', 'codegraph_queries.jsonl')
    : null;
  return { workspaceLog, runLog };
}

function runDirectoryExists(runDir: string): boolean {
  try {
    return fs.existsSync(runDir) && fs.statSync(runDir).isDirectory();
  } catch {
    return false;
  }
}

function appendJsonl(filePath: string, event: CodeGraphQueryLogEvent): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
}

export interface LogCodeGraphQueryOptions {
  repoRoot: string;
  runId?: string | null;
  event: CodeGraphQueryLogEvent;
}

/**
 * Append a single JSONL event to the workspace log and (when available) to the
 * run-scoped log. Logging failures never throw; they are returned as warnings
 * so the calling command can still succeed.
 */
export function logCodeGraphQuery(opts: LogCodeGraphQueryOptions): CodeGraphQueryLogWriteResult {
  const { repoRoot, event } = opts;
  const runId = opts.runId ?? null;
  const paths = resolveCodeGraphLogPaths(repoRoot, null);

  const warnings: string[] = [];
  let workspaceLogWritten = false;
  let runLogWritten = false;

  try {
    appendJsonl(paths.workspaceLog, event);
    workspaceLogWritten = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`CODEGRAPH_QUERY_LOG_WRITE_FAILED: workspace: ${message}`);
  }

  let runLogPath: string | null = paths.runLog;
  if (runId) {
    let runDir: string;
    try {
      runDir = resolveExplicitRunDir(repoRoot, runId).runDir;
      runLogPath = path.join(runDir, 'terminal', 'codegraph_queries.jsonl');
    } catch (error) {
      if (error instanceof LlmAdapterError && error.code === 'INVALID_RUN_ID') {
        warnings.push(`RUN_LOG_SKIPPED_INVALID_RUN_ID: ${runId}`);
        runLogPath = null;
        return {
          workspaceLogWritten,
          runLogWritten,
          warnings,
          workspaceLogPath: paths.workspaceLog,
          runLogPath,
        };
      }
      throw error;
    }
    if (!runDirectoryExists(runDir)) {
      warnings.push(`RUN_LOG_SKIPPED_RUN_NOT_FOUND: ${runId}`);
      runLogPath = null;
    } else if (runLogPath) {
      try {
        appendJsonl(runLogPath, event);
        runLogWritten = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`CODEGRAPH_QUERY_LOG_WRITE_FAILED: run: ${message}`);
      }
    }
  }

  return {
    workspaceLogWritten,
    runLogWritten,
    warnings,
    workspaceLogPath: paths.workspaceLog,
    runLogPath,
  };
}

/**
 * Resolve a run id to use for run-scoped logging. Priority:
 *   1. explicit `--run-id` (passed via `explicitRunId`)
 *   2. `process.env.VIBECODE_RUN_ID`
 *   3. null (workspace log only)
 *
 * The latest run is never used as a fallback — that would silently attribute
 * a query to a run the agent did not actually intend.
 */
export function resolveRunIdForLogging(
  explicitRunId: string | undefined | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (typeof explicitRunId === 'string' && explicitRunId.trim().length > 0) {
    return explicitRunId.trim();
  }
  const fromEnv = env.VIBECODE_RUN_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return null;
}

export interface BuildCodeGraphQueryEventOptions {
  subcommand: CodeGraphQuerySubcommand;
  repoRoot: string;
  runId: string | null;
  command: string[];
  input: CodeGraphQueryLogInput;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  warnings: string[];
  error: CodeGraphQueryLogError | null;
  stdoutBytes: number;
  stderrBytes: number;
  parsedJson: boolean;
  items: number | null;
  truncated: boolean;
  timestamp?: string;
}

/** Construct a canonical event object, ensuring no stdout/stderr text is leaked. */
export function buildCodeGraphQueryEvent(opts: BuildCodeGraphQueryEventOptions): CodeGraphQueryLogEvent {
  return {
    schema_version: CODEGRAPH_QUERY_LOG_SCHEMA_VERSION,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    run_id: opts.runId,
    tool: 'codegraph',
    subcommand: opts.subcommand,
    repo_root: opts.repoRoot,
    command: opts.command,
    input: opts.input,
    ok: opts.ok,
    exit_code: opts.exitCode,
    duration_ms: opts.durationMs,
    warnings: opts.warnings,
    error: opts.error,
    result_summary: {
      stdout_bytes: opts.stdoutBytes,
      stderr_bytes: opts.stderrBytes,
      parsed_json: opts.parsedJson,
      items: opts.items,
      truncated: opts.truncated,
    },
  };
}
