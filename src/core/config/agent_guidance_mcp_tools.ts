import type { AgentGuidanceMcpToolMetadata } from './agent_guidance_config.js';

/**
 * Settings groups for VibecodeMCP tools. This is a *display* mapping for the
 * Settings UI; the canonical tool registry lives in `src/app/mcp/tool_registry.ts`.
 * Keep these names aligned with `VIBECODE_MCP_TOOL_NAMES` — tool registry tests
 * already assert that contract.
 */
export const AGENT_GUIDANCE_MCP_TOOL_GROUPS: Readonly<
  Record<AgentGuidanceMcpToolMetadata['group'], readonly string[]>
> = Object.freeze({
  workspace_orientation: Object.freeze([
    'vibecode_workspace_info',
    'vibecode_workspace_status',
    'vibecode_mcp_guidance',
    'vibecode_project_instructions',
    'vibecode_artifacts_list',
    'vibecode_tool_profile',
    'vibecode_session_bootstrap',
    'vibecode_git_changes',
  ]),
  codegraph: Object.freeze([
    'vibecode_codegraph_status',
    'vibecode_codegraph_search',
    'vibecode_codegraph_context',
    'vibecode_codegraph_files',
    'vibecode_codegraph_callers',
    'vibecode_codegraph_callees',
    'vibecode_codegraph_impact',
  ]),
  runs_artifacts: Object.freeze([
    'vibecode_runs_list',
    'vibecode_current_run',
    'vibecode_run_get',
    'vibecode_artifact_read',
    'vibecode_codegraph_usage',
    'vibecode_scan_summary',
    'vibecode_scan_artifact_read',
  ]),
  coordination: Object.freeze([
    'vibecode_coordination_status',
    'vibecode_agent_register',
    'vibecode_agent_heartbeat',
    'vibecode_agents_list',
    'vibecode_agent_status',
    'vibecode_claim_add',
    'vibecode_claims_list',
    'vibecode_claim_status',
    'vibecode_claim_release',
    'vibecode_claims_plan',
    'vibecode_claims_add_bulk',
    'vibecode_finalize_check',
    'vibecode_evidence_list',
    'vibecode_evidence_scan',
    'vibecode_claims_reap',
    'vibecode_conflicts_list',
    'vibecode_conflict_resolve',
  ]),
});

const DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  vibecode_workspace_info: 'Workspace identity and MCP capability summary; start here when entering a repo.',
  vibecode_workspace_status: 'Read-only workspace status: branch, dirty state, current run, CodeGraph state.',
  vibecode_mcp_guidance: 'Compact guide describing when to use each VibecodeMCP tool.',
  vibecode_project_instructions: 'Bounded project instructions (AGENTS.md, README.md, codegraph docs).',
  vibecode_artifacts_list: 'List allowlisted Vibecode run artifacts before reading them.',
  vibecode_tool_profile: 'Named, deterministic recommended tool sets for common agent situations (orientation, pre/post-edit, scan, artifacts, safe commit, conflicts). Omit profile to list; pass a profile id for the full set. Static and read-only.',
  vibecode_session_bootstrap: 'One-call orientation: git/dirty state, run/artifacts, agents, claims/conflicts, scan/CodeGraph status, project-instruction excerpt, protocol, and recommended next tools.',
  vibecode_git_changes: 'Claim-aware changed-files summary with categories, classification, counts, and a bounded diff stat (no full diff; not a commit guard).',
  vibecode_codegraph_status: 'Detect whether upstream CodeGraph is installed and the repo has an initialized index.',
  vibecode_codegraph_search: 'Search for symbols in the indexed Vibecode-bound repo.',
  vibecode_codegraph_context: 'Build bounded markdown subsystem context from the existing CodeGraph index.',
  vibecode_codegraph_files: 'List the indexed project file structure from the existing CodeGraph index.',
  vibecode_codegraph_callers: 'Return callers of an indexed symbol.',
  vibecode_codegraph_callees: 'Return callees of an indexed symbol.',
  vibecode_codegraph_impact: 'Traverse change-impact for a symbol or path against the existing CodeGraph index.',
  vibecode_runs_list: 'List recent Vibecode runs for the bound repo, newest first.',
  vibecode_current_run: 'Return the current/latest Vibecode run pointer and which run artifacts are present.',
  vibecode_run_get: 'Show one Vibecode run by id or via the alias latest/current.',
  vibecode_artifact_read: 'Read one allowlisted Vibecode run artifact (final_prompt, context_pack, …).',
  vibecode_codegraph_usage: 'Return structured CodeGraph usage for a Vibecode run.',
  vibecode_scan_summary: 'Compact bounded summary of existing scan artifacts (files/commands/tests/symbols/imports/entrypoints/instructions/tooling/git). Read-only; does not run the scanner.',
  vibecode_scan_artifact_read: 'Read one allowlisted scan artifact by key in bounded, continuation-friendly chunks. Read-only; does not run the scanner.',
  vibecode_coordination_status: 'Read-only multi-agent coordination status (advisory; no source-file locks).',
  vibecode_agent_register: 'Register a persistent agent session (advisory; writes only generated coordination state).',
  vibecode_agent_heartbeat: 'Record a heartbeat for a registered agent, reviving a stale/idle session to active.',
  vibecode_agents_list: 'List registered agent sessions with their computed (stale-aware) status.',
  vibecode_agent_status: 'Return one registered agent session by id with its computed status.',
  vibecode_claim_add: 'Create an advisory file claim for an active registered agent.',
  vibecode_claims_list: 'List advisory file claims with computed stale-aware status.',
  vibecode_claim_status: 'Return advisory claim status for one repository-relative path.',
  vibecode_claim_release: 'Release an advisory file claim.',
  vibecode_claims_plan: 'Read-only: evaluate whether the explicit paths an agent declares can be claimed (claimable / owned / blocked / stale / generated / missing / invalid). Vibecode never infers paths.',
  vibecode_claims_add_bulk: 'Claim the explicit paths an agent declares as one atomic work intent (build agents only). Blocked atomically on conflict; idempotent for already-owned paths; extend your own intent via intent_id.',
  vibecode_finalize_check: 'Read-only finalize check: classify the dirty working tree against an agent’s active advisory claims (not a commit guard).',
  vibecode_evidence_list: 'List watcher evidence events (advisory; non-enforcing). Read-only.',
  vibecode_evidence_scan: 'Scan the dirty git working tree into advisory evidence (writes only generated coordination state; no git/source mutation).',
  vibecode_claims_reap: 'Release claims owned by stale or terminated agents (writes only generated coordination state).',
  vibecode_conflicts_list: 'List recorded coordination conflicts (claim_denied, stale_claim). Read-only.',
  vibecode_conflict_resolve: 'Mark a coordination conflict as resolved (writes only generated coordination state).',
});

/**
 * Build the read-only metadata list shown in the Agent Guidance settings tab.
 *
 * The list is built from the static group mapping above, NOT by introspecting a
 * running MCP server. This keeps the Settings view available even when no MCP
 * server is connected. Pass `availableNames` to filter the list to whatever
 * tools the current branch actually ships (e.g. tolerate the MCP-2 state where
 * the workspace orientation tools are not yet present).
 */
export function buildAgentGuidanceMcpTools(opts: {
  availableNames?: ReadonlySet<string>;
} = {}): AgentGuidanceMcpToolMetadata[] {
  const out: AgentGuidanceMcpToolMetadata[] = [];
  for (const group of Object.keys(AGENT_GUIDANCE_MCP_TOOL_GROUPS) as Array<
    AgentGuidanceMcpToolMetadata['group']
  >) {
    for (const name of AGENT_GUIDANCE_MCP_TOOL_GROUPS[group]) {
      if (opts.availableNames && !opts.availableNames.has(name)) continue;
      out.push({
        name,
        group,
        description: DESCRIPTIONS[name] ?? '',
      });
    }
  }
  return out;
}
