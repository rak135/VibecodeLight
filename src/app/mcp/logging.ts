import fs from 'fs';
import path from 'path';

import type { CodeGraphBinarySource } from '../../adapters/codegraph/codegraph_binary_resolver.js';
import type { CodeGraphTransport } from '../../adapters/codegraph/codegraph_transport.js';
import { MCP_TOOL_USAGE_LOG_RELATIVE_PATH } from '../../core/observability/mcp_usage_log.js';

/**
 * Append-only JSONL logger for VibecodeMCP tool calls.
 *
 * Records land at `<repoRoot>/.vibecode/logs/mcp_tool_usage.jsonl`. Each record
 * captures bounded metadata about a single tool invocation — never the full
 * stdout/stderr, never env values, never API keys.
 *
 * Hard rules:
 *   - the log file is created lazily under .vibecode/logs/;
 *   - logging failures NEVER fail the tool call — they are returned as warnings
 *     so the caller can include them in the structured response;
 *   - input_summary holds only bounded shape metadata (byte counts, integer
 *     options), never the raw query/symbol text payload above a small cap;
 *   - errors record code + message + retryable; no stack traces.
 */

export const MCP_TOOL_USAGE_LOG_SCHEMA_VERSION = 1;

// Single source of truth for the log location lives in core (the read side);
// re-exported here so existing app-side imports keep working.
export { MCP_TOOL_USAGE_LOG_RELATIVE_PATH };

export interface McpToolUsageInputSummary {
  /** UTF-8 byte length of the query/symbol payload, if any. */
  query_bytes?: number;
  /** Numeric bound options forwarded to the underlying core service. */
  max_results?: number;
  max_nodes?: number;
  max_code?: number;
  limit?: number;
  timeout_ms?: number;
  /** Bounded attribution flags — never the raw agent/intent/path values. */
  has_agent_id?: boolean;
  has_intent_id?: boolean;
  path_count?: number;
  artifact_type?: 'run' | 'scan';
}

export interface McpToolUsageError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface McpToolUsageEvent {
  schema_version: typeof MCP_TOOL_USAGE_LOG_SCHEMA_VERSION;
  timestamp: string;
  request_id: string | null;
  transport: 'stdio';
  /** Event source surface. MCP server events are always 'mcp'. */
  source: 'mcp';
  tool: string;
  repo_root: string;
  /** Explicit attribution only; absent means honestly unattributed. */
  agent_id?: string;
  session_id?: string;
  agent_mode?: 'read_only' | 'build';
  input_summary: McpToolUsageInputSummary;
  ok: boolean;
  duration_ms: number;
  warnings: string[];
  error: McpToolUsageError | null;
  output_bytes: number;
  truncated: boolean;
  codegraph?: {
    binary_source?: CodeGraphBinarySource;
    transport?: CodeGraphTransport;
  };
}

export interface McpToolUsageWriteResult {
  written: boolean;
  warnings: string[];
  path: string;
}

export function resolveMcpToolUsageLogPath(repoRoot: string): string {
  return path.join(repoRoot, MCP_TOOL_USAGE_LOG_RELATIVE_PATH);
}

/** Build a canonical, secret-free event for one MCP tool call. */
export function buildMcpToolUsageEvent(opts: {
  tool: string;
  repoRoot: string;
  requestId: string | null;
  inputSummary: McpToolUsageInputSummary;
  ok: boolean;
  durationMs: number;
  warnings: string[];
  error: McpToolUsageError | null;
  outputBytes: number;
  truncated: boolean;
  agentId?: string;
  sessionId?: string;
  agentMode?: 'read_only' | 'build';
  codegraph?: {
    binary_source?: CodeGraphBinarySource;
    transport?: CodeGraphTransport;
  };
  timestamp?: string;
}): McpToolUsageEvent {
  return {
    schema_version: MCP_TOOL_USAGE_LOG_SCHEMA_VERSION,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    request_id: opts.requestId,
    transport: 'stdio',
    source: 'mcp',
    tool: opts.tool,
    repo_root: opts.repoRoot,
    ...(opts.agentId !== undefined ? { agent_id: opts.agentId } : {}),
    ...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
    ...(opts.agentMode !== undefined ? { agent_mode: opts.agentMode } : {}),
    input_summary: opts.inputSummary,
    ok: opts.ok,
    duration_ms: opts.durationMs,
    warnings: opts.warnings,
    error: opts.error,
    output_bytes: opts.outputBytes,
    truncated: opts.truncated,
    ...(opts.codegraph ? { codegraph: opts.codegraph } : {}),
  };
}

/**
 * Append a single JSONL event. Returns a structured write result that includes
 * any warnings encountered during the append. Never throws.
 */
export function appendMcpToolUsage(repoRoot: string, event: McpToolUsageEvent): McpToolUsageWriteResult {
  const filePath = resolveMcpToolUsageLogPath(repoRoot);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    return { written: true, warnings: [], path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      written: false,
      warnings: [`MCP_TOOL_USAGE_LOG_WRITE_FAILED: ${message}`],
      path: filePath,
    };
  }
}
