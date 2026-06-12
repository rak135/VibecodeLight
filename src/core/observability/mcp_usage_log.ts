import fs from 'fs';
import path from 'path';

/**
 * Tolerant, bounded reader for the VibecodeMCP tool-usage JSONL log.
 *
 * The log is written by the MCP server (`src/app/mcp/logging.ts`, which imports
 * the relative path constant from here so writer and reader can never drift).
 * This reader is the observability-side counterpart:
 *   - read-only — it never creates, truncates, or rewrites the log;
 *   - bounded — only the trailing window of the file is read, so an old,
 *     long-running log can never balloon the overview;
 *   - tolerant — malformed lines and unknown shapes are counted and skipped,
 *     never thrown; a missing log is a normal empty result.
 */

export const MCP_TOOL_USAGE_LOG_RELATIVE_PATH = '.vibecode/logs/mcp_tool_usage.jsonl';

/** Default trailing read window. Roughly thousands of events. */
export const MCP_USAGE_LOG_DEFAULT_WINDOW_BYTES = 512 * 1024;

/** One usage event in reader shape (a bounded projection of the stored row). */
export interface McpUsageLogEvent {
  timestamp: string;
  tool_name: string;
  agent_id?: string;
  agent_mode?: 'read_only' | 'build';
  ok: boolean;
  duration_ms: number;
  error_code?: string;
}

export interface McpUsageLogReadResult {
  /** False when the log file does not exist (normal for a fresh repo). */
  log_found: boolean;
  /** Parsed events in file (chronological) order, within the read window. */
  events: McpUsageLogEvent[];
  /** Lines inside the window that could not be parsed as usage events. */
  malformed_line_count: number;
  /** True when the file was larger than the read window (older events skipped). */
  window_truncated: boolean;
}

export function resolveMcpUsageLogPath(repoRoot: string): string {
  return path.join(repoRoot, MCP_TOOL_USAGE_LOG_RELATIVE_PATH);
}

function parseEventLine(line: string): McpUsageLogEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.tool !== 'string' || row.tool.length === 0) return null;
  if (typeof row.timestamp !== 'string' || typeof row.ok !== 'boolean') return null;
  const event: McpUsageLogEvent = {
    timestamp: row.timestamp,
    tool_name: row.tool,
    ok: row.ok,
    duration_ms: typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms) ? row.duration_ms : 0,
  };
  if (typeof row.agent_id === 'string' && row.agent_id.trim() !== '') event.agent_id = row.agent_id;
  if (row.agent_mode === 'read_only' || row.agent_mode === 'build') event.agent_mode = row.agent_mode;
  const error = row.error as { code?: unknown } | null | undefined;
  if (error && typeof error === 'object' && typeof error.code === 'string') event.error_code = error.code;
  return event;
}

/**
 * Read the trailing window of the usage log. Never throws and never writes;
 * any I/O failure degrades to an empty "not found" result.
 */
export function readMcpToolUsageLog(
  repoRoot: string,
  options: { windowBytes?: number } = {},
): McpUsageLogReadResult {
  const windowBytes = options.windowBytes ?? MCP_USAGE_LOG_DEFAULT_WINDOW_BYTES;
  const logPath = resolveMcpUsageLogPath(repoRoot);
  let fd: number | undefined;
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile()) return { log_found: false, events: [], malformed_line_count: 0, window_truncated: false };
    const windowTruncated = stat.size > windowBytes;
    const start = windowTruncated ? stat.size - windowBytes : 0;
    fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    // Drop the first (likely partial) line when the window cut into the file.
    if (windowTruncated) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    const events: McpUsageLogEvent[] = [];
    let malformed = 0;
    for (const line of lines) {
      const event = parseEventLine(line);
      if (event) events.push(event);
      else malformed += 1;
    }
    return { log_found: true, events, malformed_line_count: malformed, window_truncated: windowTruncated };
  } catch {
    return { log_found: false, events: [], malformed_line_count: 0, window_truncated: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
