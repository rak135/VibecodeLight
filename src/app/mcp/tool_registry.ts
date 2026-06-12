import {
  appendAgentGuidanceToToolDescription,
  buildAgentGuidanceRuntime,
  type AgentGuidanceRuntime,
} from '../../core/agent_guidance/agent_guidance_runtime.js';
import type { McpToolFormattedResult } from './format.js';
import type { JsonSchema } from './schemas.js';
import { buildV1McpTools } from './tools/v1_contract.js';

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
  /** Effective Agent Guidance loaded at server startup for this MCP session. */
  readonly agentGuidance?: AgentGuidanceRuntime;
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

export interface BuildVibecodeMcpToolsOptions {
  agentGuidance?: AgentGuidanceRuntime;
  agentGuidanceEnv?: Record<string, string | undefined>;
}

/** VibecodeMCP Tool Contract v1 public tool names, in tools/list order. */
export const VIBECODE_MCP_TOOL_NAMES: readonly string[] = Object.freeze([
  'vibecode_session_start',
  'vibecode_workspace_snapshot',
  'vibecode_project_instructions',
  'vibecode_run_status',
  'vibecode_artifact_read',
  'vibecode_changes',
  'vibecode_codegraph_search',
  'vibecode_codegraph_explore',
  'vibecode_codegraph_callers',
  'vibecode_codegraph_impact',
  'vibecode_build_start',
  'vibecode_build_scope',
  'vibecode_build_finish',
  'vibecode_handoff',
]);

/**
 * Build the VibecodeMCP v1 public tool set. Old MCP names are intentionally
 * not registered here; old tool modules may still be reused internally by the
 * v1 wrappers, but they are not callable through MCP.
 */
export function buildVibecodeMcpTools(options: BuildVibecodeMcpToolsOptions = {}): McpToolDefinition[] {
  const runtime = options.agentGuidance ??
    (options.agentGuidanceEnv ? buildAgentGuidanceRuntime({ env: options.agentGuidanceEnv }) : undefined);
  const tools = buildV1McpTools();
  if (!runtime) return tools;
  return tools.map((tool) => ({
    ...tool,
    description: appendAgentGuidanceToToolDescription(tool.description, tool.name, runtime),
  }));
}
