import type { CodeGraphQueryResult } from '../../adapters/codegraph/codegraph_query_commands.js';
import type { CodeGraphStatusResult } from '../../adapters/codegraph/codegraph_actions.js';
import {
  buildMcpError,
  type McpErrorCode,
  type McpStructuredError,
} from './errors.js';

/**
 * Map a CodeGraphQueryResult error to a stable MCP error code. Mirrors the
 * mapping the CLI uses for the same query services so MCP/CLI parity holds.
 */
export function mcpErrorCodeForQueryFailure(code: string | undefined): McpErrorCode {
  switch (code) {
    case 'CODEGRAPH_NOT_INSTALLED':
      return 'CODEGRAPH_NOT_INSTALLED';
    case 'CODEGRAPH_NOT_INITIALIZED':
      return 'CODEGRAPH_NOT_INITIALIZED';
    case 'INVALID_ARGUMENT':
    case 'CODEGRAPH_DISALLOWED_SUBCOMMAND':
    case 'INVALID_REPO_PATH':
      return 'INVALID_ARGUMENT';
    case 'CODEGRAPH_QUERY_FAILED':
    case 'CODEGRAPH_JSON_PARSE_FAILED':
    default:
      return 'CODEGRAPH_QUERY_FAILED';
  }
}

/** Bounded byte cap on the text content block returned by every tool. */
export const MCP_TEXT_OUTPUT_LIMIT = 16_000;

/** Truncate a UTF-8 string to at most `limit` bytes and report whether it was truncated. */
export function boundUtf8(text: string, limit = MCP_TEXT_OUTPUT_LIMIT): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, truncated: false };
  const cut = buf.subarray(0, limit).toString('utf8');
  return { text: cut, truncated: true };
}

export interface McpToolContentBlock {
  type: 'text';
  text: string;
}

export interface McpToolStructured {
  ok: boolean;
  tool: string;
  repo_root: string;
  command?: string[];
  warnings: string[];
  truncated: boolean;
  duration_ms?: number;
  data?: unknown;
  error?: McpStructuredError;
}

export interface McpToolFormattedResult {
  content: McpToolContentBlock[];
  structuredContent: McpToolStructured;
  isError: boolean;
}

/** Build a successful MCP tool result from a CodeGraphQueryResult. */
export function formatQueryResultSuccess(args: {
  tool: string;
  text: string;
  data: unknown;
  result: CodeGraphQueryResult;
  durationMs: number;
}): McpToolFormattedResult {
  const bounded = boundUtf8(args.text);
  const warnings = [...args.result.warnings];
  if (bounded.truncated) warnings.push('OUTPUT_TRUNCATED: text content exceeded bounded MCP limit');
  const noteLines: string[] = [];
  if (bounded.truncated) noteLines.push('(output truncated to bounded MCP limit)');
  if (warnings.length > 0) noteLines.push(`warnings: ${warnings.length}`);
  const contentText = noteLines.length === 0 ? bounded.text : `${bounded.text}\n\n${noteLines.join('\n')}`;
  return {
    content: [{ type: 'text', text: contentText }],
    structuredContent: {
      ok: true,
      tool: args.tool,
      repo_root: args.result.repoRoot,
      command: args.result.command,
      warnings,
      truncated: bounded.truncated,
      duration_ms: args.durationMs,
      data: args.data,
    },
    isError: false,
  };
}

/** Build a failing MCP tool result from a CodeGraphQueryResult that returned ok=false. */
export function formatQueryResultFailure(args: {
  tool: string;
  result: CodeGraphQueryResult;
  durationMs: number;
}): McpToolFormattedResult {
  const code = mcpErrorCodeForQueryFailure(args.result.error?.code);
  const message = args.result.error?.message ?? 'codegraph query failed';
  const err = buildMcpError(code, message);
  return formatError({
    tool: args.tool,
    repoRoot: args.result.repoRoot,
    command: args.result.command,
    warnings: args.result.warnings,
    durationMs: args.durationMs,
    error: err,
  });
}

/** Build a successful MCP tool result for the codegraph status call. */
export function formatStatusSuccess(args: {
  repoRoot: string;
  status: CodeGraphStatusResult;
  durationMs: number;
}): McpToolFormattedResult {
  const lines: string[] = [];
  lines.push(`# vibecode_codegraph_status`);
  lines.push('');
  lines.push(`available: ${args.status.available ? 'yes' : 'no'}`);
  lines.push(`initialized: ${args.status.initialized ? 'yes' : 'no'}`);
  if (args.status.version) lines.push(`version: ${args.status.version}`);
  lines.push(`repo: ${args.repoRoot}`);
  if (args.status.warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const w of args.status.warnings) lines.push(`  - ${w}`);
  }
  const data = {
    available: args.status.available,
    initialized: args.status.initialized,
    version: args.status.version,
    binary: args.status.binary
      ? {
          command: args.status.binary.command,
          source: args.status.binary.source,
          configured: args.status.binary.configured,
        }
      : undefined,
  };
  const bounded = boundUtf8(lines.join('\n'));
  return {
    content: [{ type: 'text', text: bounded.text }],
    structuredContent: {
      ok: true,
      tool: 'vibecode_codegraph_status',
      repo_root: args.repoRoot,
      warnings: args.status.warnings,
      truncated: bounded.truncated,
      duration_ms: args.durationMs,
      data,
    },
    isError: false,
  };
}

export interface FormatErrorArgs {
  tool: string;
  repoRoot: string;
  command?: string[];
  warnings: string[];
  durationMs: number;
  error: McpStructuredError;
}

/**
 * Build a success envelope for a plain Vibecode core call (no upstream codegraph
 * subprocess). Used by run/artifact tools to wrap structured data in the same
 * shape as the CodeGraph tools' output.
 */
export function formatSimpleSuccess(args: {
  tool: string;
  repoRoot: string;
  text: string;
  data: unknown;
  durationMs: number;
  warnings?: string[];
}): McpToolFormattedResult {
  const warnings = [...(args.warnings ?? [])];
  const bounded = boundUtf8(args.text);
  if (bounded.truncated) warnings.push('OUTPUT_TRUNCATED: text content exceeded bounded MCP limit');
  return {
    content: [{ type: 'text', text: bounded.text }],
    structuredContent: {
      ok: true,
      tool: args.tool,
      repo_root: args.repoRoot,
      warnings,
      truncated: bounded.truncated,
      duration_ms: args.durationMs,
      data: args.data,
    },
    isError: false,
  };
}

/** Build an MCP tool error envelope. Never throws; logging is the caller's job. */
export function formatError(args: FormatErrorArgs): McpToolFormattedResult {
  const lines: string[] = [];
  lines.push(`[${args.error.code}] ${args.error.message}`);
  if (args.error.suggestion) lines.push(`suggestion: ${args.error.suggestion}`);
  if (args.warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const w of args.warnings) lines.push(`  - ${w}`);
  }
  const bounded = boundUtf8(lines.join('\n'));
  return {
    content: [{ type: 'text', text: bounded.text }],
    structuredContent: {
      ok: false,
      tool: args.tool,
      repo_root: args.repoRoot,
      command: args.command,
      warnings: args.warnings,
      truncated: bounded.truncated,
      duration_ms: args.durationMs,
      error: args.error,
    },
    isError: true,
  };
}
