import {
  buildAgentRegisterTool,
  buildAgentHeartbeatTool,
  buildAgentsListTool,
  buildAgentStatusTool,
} from './tools/agents.js';
import {
  buildClaimAddTool,
  buildClaimsListTool,
  buildClaimStatusTool,
  buildClaimReleaseTool,
} from './tools/claims.js';
import { buildArtifactReadTool } from './tools/artifact_read.js';
import { buildArtifactsListTool } from './tools/artifacts_list.js';
import { buildCodeGraphContextTool } from './tools/codegraph_context.js';
import { buildCodeGraphFilesTool } from './tools/codegraph_files.js';
import { buildCodeGraphSearchTool } from './tools/codegraph_search.js';
import { buildCodeGraphStatusTool } from './tools/codegraph_status.js';
import { buildCodeGraphUsageTool } from './tools/codegraph_usage.js';
import { buildCoordinationStatusTool } from './tools/coordination_status.js';
import { buildCurrentRunTool } from './tools/current_run.js';
import { buildMcpGuidanceTool } from './tools/mcp_guidance.js';
import { buildProjectInstructionsTool } from './tools/project_instructions.js';
import { buildRunGetTool } from './tools/run_get.js';
import { buildRunsListTool } from './tools/runs_list.js';
import { buildWorkspaceInfoTool } from './tools/workspace_info.js';
import { buildWorkspaceStatusTool } from './tools/workspace_status.js';
import {
  buildCodeGraphCallersTool,
  buildCodeGraphCalleesTool,
  buildCodeGraphImpactTool,
} from './tools/codegraph_symbol.js';
import {
  appendAgentGuidanceToToolDescription,
  buildAgentGuidanceRuntime,
  type AgentGuidanceRuntime,
} from '../../core/agent_guidance/agent_guidance_runtime.js';
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

/**
 * Build the canonical tool set: seven read-only CodeGraph tools (Phase MCP-1),
 * five read-only run/artifact tools (Phase MCP-2), and five read-only
 * workspace orientation tools (Phase MCP-3). The order here is the order
 * returned in `tools/list`.
 *
 * MCP-capable agents should prefer these VibecodeMCP tools over shelling out
 * to grep/find or opening .vibecode files by hand. Agents without MCP support
 * should fall back to the equivalent `vibecode codegraph …` / `vibecode runs …`
 * CLI commands.
 */
export function buildVibecodeMcpTools(options: BuildVibecodeMcpToolsOptions = {}): McpToolDefinition[] {
  const runtime = options.agentGuidance ??
    (options.agentGuidanceEnv ? buildAgentGuidanceRuntime({ env: options.agentGuidanceEnv }) : undefined);
  const tools = [
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
    // Phase MCP-3: read-only workspace orientation.
    buildWorkspaceInfoTool(),
    buildWorkspaceStatusTool(),
    buildMcpGuidanceTool(),
    buildProjectInstructionsTool(),
    buildArtifactsListTool(),
    // Phase Coordination-1: read-only multi-agent coordination status.
    buildCoordinationStatusTool(),
    // Phase Coordination-2: persistent agent session registry + heartbeat.
    buildAgentRegisterTool(),
    buildAgentHeartbeatTool(),
    buildAgentsListTool(),
    buildAgentStatusTool(),
    // Phase Coordination-3A: advisory file claims.
    buildClaimAddTool(),
    buildClaimsListTool(),
    buildClaimStatusTool(),
    buildClaimReleaseTool(),
  ];
  if (!runtime) return tools;
  return tools.map((tool) => ({
    ...tool,
    description: appendAgentGuidanceToToolDescription(tool.description, tool.name, runtime),
  }));
}

/** Canonical list of tool names exposed by the server (MCP-1 + MCP-2 + MCP-3). */
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
  // Phase MCP-3
  'vibecode_workspace_info',
  'vibecode_workspace_status',
  'vibecode_mcp_guidance',
  'vibecode_project_instructions',
  'vibecode_artifacts_list',
  // Phase Coordination-1
  'vibecode_coordination_status',
  // Phase Coordination-2
  'vibecode_agent_register',
  'vibecode_agent_heartbeat',
  'vibecode_agents_list',
  'vibecode_agent_status',
  // Phase Coordination-3A
  'vibecode_claim_add',
  'vibecode_claims_list',
  'vibecode_claim_status',
  'vibecode_claim_release',
]);
