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
  buildClaimsReapTool,
} from './tools/claims.js';
import {
  buildClaimsPlanTool,
  buildClaimsAddBulkTool,
} from './tools/claims_bulk.js';
import {
  buildClaimIntentsListTool,
  buildClaimIntentReleaseTool,
} from './tools/claim_intent_lifecycle.js';
import {
  buildConflictsListTool,
  buildConflictResolveTool,
  buildConflictDetailTool,
} from './tools/conflicts.js';
import { buildArtifactReadTool } from './tools/artifact_read.js';
import { buildArtifactsListTool } from './tools/artifacts_list.js';
import { buildCodeGraphContextTool } from './tools/codegraph_context.js';
import { buildCodeGraphFilesTool } from './tools/codegraph_files.js';
import { buildCodeGraphSearchTool } from './tools/codegraph_search.js';
import { buildCodeGraphStatusTool } from './tools/codegraph_status.js';
import { buildCodeGraphUsageTool } from './tools/codegraph_usage.js';
import { buildCoordinationStatusTool } from './tools/coordination_status.js';
import { buildEvidenceListTool, buildEvidenceScanTool } from './tools/evidence.js';
import { buildFinalizeCheckTool } from './tools/finalize_check.js';
import { buildCurrentRunTool } from './tools/current_run.js';
import { buildGitChangesTool } from './tools/git_changes.js';
import { buildScanSummaryTool } from './tools/scan_summary.js';
import { buildScanArtifactReadTool } from './tools/scan_artifact_read.js';
import { buildSessionBootstrapTool } from './tools/session_bootstrap.js';
import { buildHandoffPrepareTool } from './tools/handoff_prepare.js';
import { buildHandoffGuideTool } from './tools/handoff_guide.js';
import { buildToolProfileTool } from './tools/tool_profile.js';
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
    // Phase 1B-2: bounded scan summary + allowlisted scan artifact reads.
    buildScanSummaryTool(),
    buildScanArtifactReadTool(),
    // Phase MCP-3: read-only workspace orientation.
    buildWorkspaceInfoTool(),
    buildWorkspaceStatusTool(),
    buildMcpGuidanceTool(),
    buildProjectInstructionsTool(),
    buildArtifactsListTool(),
    // Phase 1B-3: named recommended tool sets (read-only, static).
    buildToolProfileTool(),
    // Phase 1A: one-call session bootstrap + claim-aware git changes.
    buildSessionBootstrapTool(),
    buildGitChangesTool(),
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
    // Phase 2A: agent-declared work scope (explicit bulk claims + intents).
    buildClaimsPlanTool(),
    buildClaimsAddBulkTool(),
    // Phase 2B: claim intent lifecycle (list + release).
    buildClaimIntentsListTool(),
    buildClaimIntentReleaseTool(),
    // Phase Coordination-4A: read-only agent-aware finalize check.
    buildFinalizeCheckTool(),
    // Phase Coordination-4C: watcher evidence (list is read-only; scan writes
    // only generated .vibecode/coordination/events.jsonl — no git/source mutation).
    buildEvidenceListTool(),
    buildEvidenceScanTool(),
    // Phase Coordination-4D-cleanup: claims reap + conflict history.
    buildClaimsReapTool(),
    buildConflictsListTool(),
    buildConflictResolveTool(),
    // Phase 2D: intent-aware conflict triage detail.
    buildConflictDetailTool(),
    // Phase 4A: read-only handoff packet (visibility only; no ownership transfer).
    buildHandoffPrepareTool(),
    // Phase 4B: read-only next-agent onboarding guide (guidance only; no transfer).
    buildHandoffGuideTool(),
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
  // Phase 1B-2
  'vibecode_scan_summary',
  'vibecode_scan_artifact_read',
  // Phase MCP-3
  'vibecode_workspace_info',
  'vibecode_workspace_status',
  'vibecode_mcp_guidance',
  'vibecode_project_instructions',
  'vibecode_artifacts_list',
  // Phase 1B-3
  'vibecode_tool_profile',
  // Phase 1A
  'vibecode_session_bootstrap',
  'vibecode_git_changes',
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
  // Phase 2A
  'vibecode_claims_plan',
  'vibecode_claims_add_bulk',
  // Phase 2B
  'vibecode_claim_intents_list',
  'vibecode_claim_intent_release',
  // Phase Coordination-4A
  'vibecode_finalize_check',
  // Phase Coordination-4C
  'vibecode_evidence_list',
  'vibecode_evidence_scan',
  // Phase Coordination-4D-cleanup
  'vibecode_claims_reap',
  'vibecode_conflicts_list',
  'vibecode_conflict_resolve',
  // Phase 2D
  'vibecode_conflict_detail',
  // Phase 4A
  'vibecode_handoff_prepare',
  // Phase 4B
  'vibecode_handoff_guide',
]);
