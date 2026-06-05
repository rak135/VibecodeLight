import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildMcpError } from './errors.js';
import { formatError, type McpToolFormattedResult } from './format.js';
import {
  appendMcpToolUsage,
  buildMcpToolUsageEvent,
  type McpToolUsageError,
  type McpToolUsageInputSummary,
} from './logging.js';
import {
  buildVibecodeMcpTools,
  type McpServerContext,
  type McpToolDefinition,
} from './tool_registry.js';

/**
 * In-process VibecodeMCP stdio server. The server is repo-bound at startup;
 * tools never accept a `repo` argument. Tool handlers call existing Vibecode
 * core/adapter services in-process — no shell-out, no CLI text parsing.
 *
 * stdout is reserved exclusively for the MCP JSON-RPC protocol stream. Any
 * human/operator log goes to stderr (controlled by `logLevel`) or to
 * `.vibecode/logs/mcp_tool_usage.jsonl` via the logging module.
 */

export const VIBECODE_MCP_SERVER_NAME = 'vibecode-mcp';
export const VIBECODE_MCP_SERVER_VERSION = '0.1.0';

export type McpLogLevel = 'info' | 'warn' | 'silent';

export interface VibecodeMcpServerOptions {
  /** Repo binding (already resolved by the CLI / caller). */
  context: McpServerContext;
  /** Tool definitions; defaults to the canonical MCP-1 tool set. */
  tools?: McpToolDefinition[];
  /** Override `console.error`-style logger for tests. */
  log?: (level: 'info' | 'warn', message: string) => void;
  /** stderr log verbosity. Default: 'info'. */
  logLevel?: McpLogLevel;
}

export interface VibecodeMcpServerHandle {
  readonly server: Server;
  readonly tools: McpToolDefinition[];
  readonly context: McpServerContext;
  /** Connect the server to the provided transport (defaults to stdio). */
  connect(transport?: { readonly _kind?: never } | unknown): Promise<void>;
  close(): Promise<void>;
}

function pickInputSummary(args: Record<string, unknown> | undefined): McpToolUsageInputSummary {
  if (!args) return {};
  const summary: McpToolUsageInputSummary = {};
  for (const k of ['query', 'input', 'symbol'] as const) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === 'string') summary.query_bytes = Buffer.byteLength(v, 'utf8');
  }
  for (const k of ['maxResults', 'maxNodes', 'maxCode', 'limit', 'timeoutMs'] as const) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const out: Record<string, number> = summary as Record<string, number>;
      const key = k === 'maxResults'
        ? 'max_results'
        : k === 'maxNodes'
        ? 'max_nodes'
        : k === 'maxCode'
        ? 'max_code'
        : k === 'timeoutMs'
        ? 'timeout_ms'
        : 'limit';
      out[key] = v;
    }
  }
  return summary;
}

function buildLoggingErrorFromResult(result: McpToolFormattedResult): McpToolUsageError | null {
  if (!result.isError) return null;
  const err = result.structuredContent.error;
  return err
    ? { code: err.code, message: err.message, retryable: err.retryable }
    : { code: 'UNKNOWN', message: 'tool error without structured envelope', retryable: false };
}

function buildLoggingErrorFromCatch(err: unknown): McpToolUsageError {
  return {
    code: 'CODEGRAPH_QUERY_FAILED',
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}

function logToStderr(level: 'info' | 'warn', message: string, configuredLevel: McpLogLevel): void {
  if (configuredLevel === 'silent') return;
  if (configuredLevel === 'warn' && level === 'info') return;
  process.stderr.write(`[vibecode-mcp] ${level}: ${message}\n`);
}

/**
 * Build a configured server. The server is NOT connected to a transport until
 * the caller invokes `handle.connect(transport)`. Tests construct their own
 * in-memory transport pair; the production CLI command uses `StdioServerTransport`.
 */
export function createVibecodeMcpServer(options: VibecodeMcpServerOptions): VibecodeMcpServerHandle {
  const tools = options.tools ?? buildVibecodeMcpTools();
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const logLevel: McpLogLevel = options.logLevel ?? 'info';
  const log = options.log ?? ((level, message) => logToStderr(level, message, logLevel));

  const server = new Server(
    { name: VIBECODE_MCP_SERVER_NAME, version: VIBECODE_MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name;
    const args = request.params?.arguments as Record<string, unknown> | undefined;
    const requestId = typeof extra?.requestId === 'string' || typeof extra?.requestId === 'number'
      ? String(extra.requestId)
      : null;

    if (typeof name !== 'string' || name.length === 0) {
      const err = buildMcpError('INVALID_ARGUMENT', 'tools/call requires a non-empty tool name');
      const formatted = formatError({
        tool: '(unknown)',
        repoRoot: options.context.repoRoot,
        warnings: [],
        durationMs: 0,
        error: err,
      });
      return toCallToolResponse(formatted);
    }

    const def = toolsByName.get(name);
    if (!def) {
      const err = buildMcpError('UNSUPPORTED_TOOL', `tool not exposed by this server: ${name}`);
      const formatted = formatError({
        tool: name,
        repoRoot: options.context.repoRoot,
        warnings: [],
        durationMs: 0,
        error: err,
      });
      logToolUsage(options.context.repoRoot, {
        tool: name,
        requestId,
        inputSummary: pickInputSummary(args),
        ok: false,
        durationMs: 0,
        warnings: [],
        error: { code: err.code, message: err.message, retryable: err.retryable },
        outputBytes: Buffer.byteLength(formatted.content[0]?.text ?? '', 'utf8'),
        truncated: formatted.structuredContent.truncated,
        log,
      });
      return toCallToolResponse(formatted);
    }

    const started = Date.now();
    let formatted: McpToolFormattedResult;
    try {
      formatted = await def.handler({ context: options.context, arguments: args, requestId });
    } catch (err) {
      formatted = formatError({
        tool: name,
        repoRoot: options.context.repoRoot,
        warnings: [],
        durationMs: Date.now() - started,
        error: buildMcpError(
          'CODEGRAPH_QUERY_FAILED',
          err instanceof Error ? err.message : String(err),
        ),
      });
      logToolUsage(options.context.repoRoot, {
        tool: name,
        requestId,
        inputSummary: pickInputSummary(args),
        ok: false,
        durationMs: Date.now() - started,
        warnings: [],
        error: buildLoggingErrorFromCatch(err),
        outputBytes: Buffer.byteLength(formatted.content[0]?.text ?? '', 'utf8'),
        truncated: formatted.structuredContent.truncated,
        log,
      });
      return toCallToolResponse(formatted);
    }

    logToolUsage(options.context.repoRoot, {
      tool: name,
      requestId,
      inputSummary: pickInputSummary(args),
      ok: !formatted.isError,
      durationMs: formatted.structuredContent.duration_ms ?? Date.now() - started,
      warnings: formatted.structuredContent.warnings,
      error: buildLoggingErrorFromResult(formatted),
      outputBytes: Buffer.byteLength(formatted.content[0]?.text ?? '', 'utf8'),
      truncated: formatted.structuredContent.truncated,
      log,
    });
    return toCallToolResponse(formatted);
  });

  log('info', `bound to repo: ${options.context.repoRoot}`);

  return {
    server,
    tools,
    context: options.context,
    async connect(transport?: unknown) {
      // The SDK Transport interface is structurally typed; we accept any
      // value that quacks like a transport so tests can inject an
      // in-memory pair. Default: real stdio transport.
      const t = transport ?? new StdioServerTransport();
      await server.connect(t as Parameters<Server['connect']>[0]);
    },
    async close() {
      await server.close();
    },
  };
}

function toCallToolResponse(formatted: McpToolFormattedResult) {
  return {
    content: formatted.content,
    structuredContent: formatted.structuredContent as unknown as Record<string, unknown>,
    isError: formatted.isError,
  };
}

interface LogToolUsageArgs {
  tool: string;
  requestId: string | null;
  inputSummary: McpToolUsageInputSummary;
  ok: boolean;
  durationMs: number;
  warnings: string[];
  error: McpToolUsageError | null;
  outputBytes: number;
  truncated: boolean;
  log: (level: 'info' | 'warn', message: string) => void;
}

function logToolUsage(repoRoot: string, args: LogToolUsageArgs): void {
  try {
    const event = buildMcpToolUsageEvent({
      tool: args.tool,
      repoRoot,
      requestId: args.requestId,
      inputSummary: args.inputSummary,
      ok: args.ok,
      durationMs: args.durationMs,
      warnings: args.warnings,
      error: args.error,
      outputBytes: args.outputBytes,
      truncated: args.truncated,
    });
    const write = appendMcpToolUsage(repoRoot, event);
    if (!write.written) {
      for (const w of write.warnings) args.log('warn', w);
    }
  } catch (err) {
    // Logging must never fail the tool call. Surface as a stderr warning only.
    args.log('warn', `MCP_TOOL_USAGE_LOG_UNEXPECTED: ${err instanceof Error ? err.message : String(err)}`);
  }
}
