/**
 * Canonical VibecodeMCP v1 public tool names and the legacy → v1 mapping.
 *
 * Single source of truth shared by:
 *   - the MCP v1 contract (`src/app/mcp/tools/v1_contract.ts`), which uses the
 *     mapping to sanitize old tool names out of every tool response;
 *   - the observability overview, which normalizes historical usage-log rows
 *     (written before the v1 contract) so the GUI never displays a pre-v1
 *     tool name.
 *
 * Writer and reader import the same tables so they can never drift.
 */

export const VIBECODE_V1_TOOL_NAMES = [
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
] as const;

export type VibecodeV1ToolName = (typeof VIBECODE_V1_TOOL_NAMES)[number];

/** Pre-v1 tool names mapped to the v1 tool that replaced them. */
export const LEGACY_TO_V1_TOOL_NAMES: Readonly<Record<string, VibecodeV1ToolName>> = Object.freeze({
  vibecode_session_bootstrap: 'vibecode_session_start',
  vibecode_agent_register: 'vibecode_session_start',
  vibecode_agent_heartbeat: 'vibecode_session_start',
  vibecode_agents_list: 'vibecode_workspace_snapshot',
  vibecode_agent_status: 'vibecode_workspace_snapshot',
  vibecode_workspace_info: 'vibecode_workspace_snapshot',
  vibecode_workspace_status: 'vibecode_workspace_snapshot',
  vibecode_coordination_status: 'vibecode_workspace_snapshot',
  vibecode_team_status: 'vibecode_workspace_snapshot',
  vibecode_tool_profile: 'vibecode_workspace_snapshot',
  vibecode_mcp_guidance: 'vibecode_project_instructions',
  vibecode_runs_list: 'vibecode_run_status',
  vibecode_current_run: 'vibecode_run_status',
  vibecode_run_get: 'vibecode_run_status',
  vibecode_artifacts_list: 'vibecode_run_status',
  vibecode_scan_summary: 'vibecode_run_status',
  vibecode_scan_artifact_read: 'vibecode_artifact_read',
  vibecode_git_changes: 'vibecode_changes',
  vibecode_evidence_list: 'vibecode_changes',
  vibecode_evidence_scan: 'vibecode_changes',
  vibecode_codegraph_context: 'vibecode_codegraph_explore',
  vibecode_codegraph_files: 'vibecode_codegraph_explore',
  vibecode_codegraph_status: 'vibecode_codegraph_explore',
  vibecode_codegraph_usage: 'vibecode_codegraph_explore',
  vibecode_codegraph_callees: 'vibecode_codegraph_callers',
  vibecode_claim_add: 'vibecode_build_start',
  vibecode_claims_plan: 'vibecode_build_start',
  vibecode_claims_add_bulk: 'vibecode_build_start',
  vibecode_claim_status: 'vibecode_build_scope',
  vibecode_claims_list: 'vibecode_build_scope',
  vibecode_claim_release: 'vibecode_build_scope',
  vibecode_claim_intents_list: 'vibecode_build_scope',
  vibecode_claim_intent_release: 'vibecode_build_scope',
  vibecode_claims_reap: 'vibecode_build_scope',
  vibecode_conflicts_list: 'vibecode_workspace_snapshot',
  vibecode_conflict_detail: 'vibecode_workspace_snapshot',
  vibecode_conflict_resolve: 'vibecode_build_scope',
  vibecode_finalize_check: 'vibecode_build_finish',
  vibecode_handoff_prepare: 'vibecode_handoff',
  vibecode_handoff_guide: 'vibecode_handoff',
});

export interface NormalizedToolName {
  tool_name: string;
  /** True when the input was a recognized pre-v1 tool name. */
  was_legacy: boolean;
}

/**
 * Map a (possibly historical) tool name onto its v1 equivalent for display.
 * Unrecognized names pass through unchanged — never invented, never hidden.
 */
export function normalizeToV1ToolName(name: string): NormalizedToolName {
  const v1 = LEGACY_TO_V1_TOOL_NAMES[name];
  if (v1 !== undefined) return { tool_name: v1, was_legacy: true };
  return { tool_name: name, was_legacy: false };
}
