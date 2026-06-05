import { buildArtifactReadTool } from './tools/artifact_read.js';
import { buildCodeGraphContextTool } from './tools/codegraph_context.js';
import { buildCodeGraphFilesTool } from './tools/codegraph_files.js';
import { buildCodeGraphSearchTool } from './tools/codegraph_search.js';
import { buildCodeGraphStatusTool } from './tools/codegraph_status.js';
import { buildCodeGraphUsageTool } from './tools/codegraph_usage.js';
import { buildCurrentRunTool } from './tools/current_run.js';
import { buildRunGetTool } from './tools/run_get.js';
import { buildRunsListTool } from './tools/runs_list.js';
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
 * Build the canonical tool set: seven read-only CodeGraph tools (Phase MCP-1)
 * plus five read-only run/artifact tools (Phase MCP-2). The order here is the
 * order returned in `tools/list`.
 *
 * MCP-capable agents should prefer these VibecodeMCP tools over shelling out
 * to grep/find or opening .vibecode files by hand. Agents without MCP support
 * should fall back to the equivalent `vibecode codegraph …` / `vibecode runs …`
 * CLI commands.
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
    // Phase MCP-2: read-only run / artifact inspection.
    buildRunsListTool(),
    buildCurrentRunTool(),
    buildRunGetTool(),
    buildArtifactReadTool(),
    buildCodeGraphUsageTool(),
  ];
}

/** Canonical list of tool names exposed by the server (MCP-1 + MCP-2). */
export const VIBECODE_MCP_TOOL_NAMES: readonly string[] = Object.freeze([
  // Phase MCP-1
  'vibecode_codegraph_status',
  'vibecode_codegraph_search',
  'vibecode_codegraph_context',
  'vibecode_codegraph_files',
  'vibecode_codegraph_callers',
  'vibecode_codegraph_callees',
  'vibecode_codegraph_impact',
  // Phase MCP-2
  'vibecode_runs_list',
  'vibecode_current_run',
  'vibecode_run_get',
  'vibecode_artifact_read',
  'vibecode_codegraph_usage',
]);
