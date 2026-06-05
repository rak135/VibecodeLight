import { buildCodeGraphContextTool } from './tools/codegraph_context.js';
import { buildCodeGraphFilesTool } from './tools/codegraph_files.js';
import { buildCodeGraphSearchTool } from './tools/codegraph_search.js';
import { buildCodeGraphStatusTool } from './tools/codegraph_status.js';
import {
  buildCodeGraphCallersTool,
  buildCodeGraphCalleesTool,
  buildCodeGraphImpactTool,
} from './tools/codegraph_symbol.js';
import type { McpToolFormattedResult } from './format.js';
import type { JsonSchema } from './schemas.js';

/**
 * Per-server context passed to every tool handler. Frozen at startup so tools
 * can never mutate the repo binding or transport settings mid-session.
 */
export interface McpServerContext {
  /** Absolute repo path the server is bound to. Tools never accept a repo arg. */
  readonly repoRoot: string;
  /** Optional override for the upstream codegraph binary path. */
  readonly codegraphBinary?: string;
  /** Optional override for the persisted CodeGraph transport. */
  readonly codegraphTransport?: 'cli' | 'mcp' | 'auto';
}

export interface McpToolHandlerInput {
  context: McpServerContext;
  /** Raw arguments object as received from the MCP tools/call request. */
  arguments: Record<string, unknown> | undefined;
  /** Optional request id from the underlying JSON-RPC envelope. */
  requestId: string | null;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (input: McpToolHandlerInput) => Promise<McpToolFormattedResult>;
}

/**
 * Build the canonical Phase MCP-1 tool set: seven read-only CodeGraph tools.
 * The order here is the order returned in `tools/list`.
 */
export function buildVibecodeMcpTools(): McpToolDefinition[] {
  return [
    buildCodeGraphStatusTool(),
    buildCodeGraphSearchTool(),
    buildCodeGraphContextTool(),
    buildCodeGraphFilesTool(),
    buildCodeGraphCallersTool(),
    buildCodeGraphCalleesTool(),
    buildCodeGraphImpactTool(),
  ];
}

/** Canonical list of tool names exposed by the MCP-1 server. */
export const VIBECODE_MCP_TOOL_NAMES: readonly string[] = Object.freeze([
  'vibecode_codegraph_status',
  'vibecode_codegraph_search',
  'vibecode_codegraph_context',
  'vibecode_codegraph_files',
  'vibecode_codegraph_callers',
  'vibecode_codegraph_callees',
  'vibecode_codegraph_impact',
]);
