import {
  AGENT_GUIDANCE_MCP_TOOL_GROUPS,
} from '../../core/config/agent_guidance_mcp_tools.js';
import { listToolProfiles } from '../../core/agent_guidance/tool_profiles.js';
import { buildVibecodeMcpTools, type McpToolDefinition } from './tool_registry.js';

export type McpToolSideEffect =
  | 'read_only'
  | 'coordination_write'
  | 'git_mutation'
  | 'generated_state_write'
  | 'unknown';

export interface McpToolOutputContract {
  summary: string;
  structured_content_shape?: unknown;
  important_fields?: string[];
  text_output_notes?: string;
  example_response?: unknown;
}

export interface McpToolCatalogItem {
  name: string;
  title: string;
  group: string;
  summary: string;
  description: string;
  side_effect: McpToolSideEffect;
  input_schema: unknown;
  output_contract: McpToolOutputContract;
  cli_equivalents: string[];
  profiles: string[];
  safety_notes: string[];
  source_files: string[];
  test_files: string[];
}

export interface McpToolCatalog {
  tool_count: number;
  generated_from: {
    registry: true;
    schemas: true;
    profiles: true;
  };
  groups: Array<{
    id: string;
    title: string;
    tool_names: string[];
  }>;
  tools: McpToolCatalogItem[];
  warnings: string[];
}

export interface McpToolContractMetadata {
  title: string;
  summary: string;
  side_effect: McpToolSideEffect;
  output_contract: McpToolOutputContract;
  cli_equivalents?: string[];
  safety_notes: string[];
  source_files: string[];
  test_files: string[];
  description?: string;
}

const GROUP_TITLES: Record<string, string> = Object.freeze({
  workspace_orientation: 'Workspace orientation',
  codegraph: 'CodeGraph',
  runs_artifacts: 'Runs and artifacts',
  coordination: 'Coordination',
});

const STANDARD_STRUCTURED_ENVELOPE = Object.freeze({
  ok: 'boolean',
  tool: 'string',
  repo_root: 'string',
  warnings: 'string[]',
  truncated: 'boolean',
  duration_ms: 'number',
  data: 'tool-specific object',
});

const READ_ONLY_NOTE = 'Read-only: does not edit source files, mutate git, or write coordination state.';
const GENERATED_NOTE = 'Writes only generated Vibecode state under .vibecode; does not edit source files or mutate git.';
const COORDINATION_NOTE = 'Writes only generated advisory coordination state under .vibecode/coordination; does not edit source files or mutate git.';

function output(summary: string, important_fields: string[], text_output_notes?: string): McpToolOutputContract {
  return {
    summary,
    structured_content_shape: STANDARD_STRUCTURED_ENVELOPE,
    important_fields,
    text_output_notes: text_output_notes ?? 'Text output is a compact Markdown summary of the same structured data.',
  };
}

function contract(
  title: string,
  summary: string,
  side_effect: McpToolSideEffect,
  output_contract: McpToolOutputContract,
  opts: {
    cli?: string[];
    safety?: string[];
    source: string[];
    tests: string[];
    description?: string;
  },
): McpToolContractMetadata {
  return {
    title,
    summary,
    side_effect,
    output_contract,
    cli_equivalents: opts.cli ?? [],
    safety_notes: opts.safety ?? [side_effect === 'read_only' ? READ_ONLY_NOTE : side_effect === 'generated_state_write' ? GENERATED_NOTE : COORDINATION_NOTE],
    source_files: opts.source,
    test_files: opts.tests,
    description: opts.description,
  };
}

export const MCP_TOOL_CONTRACTS: Readonly<Record<string, McpToolContractMetadata>> = Object.freeze({
  vibecode_codegraph_status: contract(
    'CodeGraph status',
    'Detects whether CodeGraph is installed and initialized for the bound repo.',
    'read_only',
    output('Returns binary availability, index initialization state, version, and warnings.', ['available', 'initialized', 'version', 'warnings']),
    { cli: ['vibecode codegraph status --json'], source: ['src/app/mcp/tools/codegraph_status.ts'], tests: ['tests/app/mcp/codegraph_tools.test.ts'] },
  ),
  vibecode_codegraph_search: contract(
    'CodeGraph search',
    'Searches indexed symbols in the existing CodeGraph index.',
    'read_only',
    output('Returns ranked symbol/file matches from the existing local index.', ['query', 'results', 'warnings']),
    { cli: ['vibecode codegraph search "<query>" --json'], source: ['src/app/mcp/tools/codegraph_search.ts'], tests: ['tests/app/mcp/codegraph_tools.test.ts'] },
  ),
  vibecode_codegraph_context: contract(
    'CodeGraph context',
    'Builds bounded markdown context for a task or subsystem from the existing index.',
    'read_only',
    output('Returns bounded CodeGraph context text plus result metadata and warnings.', ['query', 'stdoutText', 'warnings']),
    { cli: ['vibecode codegraph context "<query>" --json'], source: ['src/app/mcp/tools/codegraph_context.ts'], tests: ['tests/app/mcp/codegraph_tools.test.ts'] },
  ),
  vibecode_codegraph_files: contract(
    'CodeGraph files',
    'Lists indexed project files from the existing CodeGraph index.',
    'read_only',
    output('Returns a bounded indexed file list and CodeGraph warnings.', ['files', 'warnings']),
    { cli: ['vibecode codegraph files --json'], source: ['src/app/mcp/tools/codegraph_files.ts'], tests: ['tests/app/mcp/codegraph_tools.test.ts'] },
  ),
  vibecode_codegraph_callers: contract(
    'CodeGraph callers',
    'Returns callers of an exact indexed symbol.',
    'read_only',
    output('Returns bounded caller relationships for the requested symbol.', ['symbol', 'results', 'warnings']),
    { cli: ['vibecode codegraph callers "<symbol>" --json'], source: ['src/app/mcp/tools/codegraph_symbol.ts'], tests: ['tests/app/mcp/codegraph_tools.test.ts'] },
  ),
  vibecode_codegraph_callees: contract(
    'CodeGraph callees',
    'Returns callees of an exact indexed symbol.',
    'read_only',
    output('Returns bounded callee relationships for the requested symbol.', ['symbol', 'results', 'warnings']),
    { cli: ['vibecode codegraph callees "<symbol>" --json'], source: ['src/app/mcp/tools/codegraph_symbol.ts'], tests: ['tests/app/mcp/codegraph_tools.test.ts'] },
  ),
  vibecode_codegraph_impact: contract(
    'CodeGraph impact',
    'Traverses change impact for a symbol or path in the existing index.',
    'read_only',
    output('Returns bounded impact traversal results and warnings.', ['input', 'results', 'warnings']),
    { cli: ['vibecode codegraph impact "<symbol-or-path>" --json'], source: ['src/app/mcp/tools/codegraph_symbol.ts'], tests: ['tests/app/mcp/codegraph_tools.test.ts'] },
  ),

  vibecode_runs_list: contract(
    'Runs list',
    'Lists recent Vibecode runs for the bound repo.',
    'read_only',
    output('Returns recent run ids, tasks, timestamps, and artifact availability.', ['runs', 'run_id', 'created_at', 'artifacts']),
    { cli: ['vibecode runs list --json'], source: ['src/app/mcp/tools/runs_list.ts'], tests: ['tests/app/mcp/runs_tools.test.ts', 'tests/app/mcp/runs_parity.test.ts'] },
  ),
  vibecode_current_run: contract(
    'Current run',
    'Returns the current/latest run pointer and artifact presence.',
    'read_only',
    output('Returns the current run id, run directory, and booleans for available key artifacts.', ['run_id', 'run_dir', 'has_final_prompt', 'has_context_pack']),
    { cli: ['vibecode runs show latest --json'], source: ['src/app/mcp/tools/current_run.ts'], tests: ['tests/app/mcp/runs_tools.test.ts'] },
  ),
  vibecode_run_get: contract(
    'Run get',
    'Shows one run by id or current/latest alias.',
    'read_only',
    output('Returns run manifest/display information and artifact paths for the selected run.', ['run_id', 'runDir', 'artifacts', 'has_final_prompt']),
    { cli: ['vibecode runs show <run_id> --json'], source: ['src/app/mcp/tools/run_get.ts'], tests: ['tests/app/mcp/runs_tools.test.ts', 'tests/app/mcp/runs_parity.test.ts'] },
  ),
  vibecode_artifact_read: contract(
    'Artifact read',
    'Reads one allowlisted run artifact in bounded chunks.',
    'read_only',
    output('Returns artifact content chunk, byte offsets, has_more, full-file hash, and path metadata.', ['artifact', 'content', 'byte_offset', 'next_byte_offset', 'has_more', 'sha256']),
    { cli: ['vibecode runs artifact-read --run <run_id> --artifact <artifact> --json'], source: ['src/app/mcp/tools/artifact_read.ts'], tests: ['tests/app/mcp/artifact_read_continuation.test.ts', 'tests/app/mcp/runs_parity.test.ts'] },
  ),
  vibecode_codegraph_usage: contract(
    'CodeGraph usage',
    'Shows CodeGraph transport/usage metadata for a Vibecode run.',
    'read_only',
    output('Returns requested/used transport, fallback status, context artifact, and warnings.', ['mode', 'transport_requested', 'transport_used', 'fallback_used', 'context_artifact']),
    { cli: ['vibecode runs show <run_id> --artifact codegraph_usage --json'], source: ['src/app/mcp/tools/codegraph_usage.ts'], tests: ['tests/app/mcp/runs_tools.test.ts'] },
  ),
  vibecode_scan_summary: contract(
    'Scan summary',
    'Summarizes existing deterministic scan artifacts without running the scanner.',
    'read_only',
    output('Returns scan availability plus bounded sections for files, commands, tests, symbols, imports, entrypoints, instructions, tooling, and git.', ['scan_available', 'available_artifacts', 'sections', 'recommended_next_tools']),
    { cli: ['vibecode scan summary --run current --json'], source: ['src/app/mcp/tools/scan_summary.ts'], tests: ['tests/app/mcp/scan_tools.test.ts'] },
  ),
  vibecode_scan_artifact_read: contract(
    'Scan artifact read',
    'Reads one allowlisted scan artifact by key in bounded chunks.',
    'read_only',
    output('Returns scan artifact content chunk, byte offsets, has_more, relative path, and hash metadata.', ['artifact', 'relative_path', 'content', 'byte_offset', 'next_byte_offset', 'has_more']),
    { cli: ['vibecode scan artifact-read --run current --artifact <artifact> --json'], source: ['src/app/mcp/tools/scan_artifact_read.ts'], tests: ['tests/app/mcp/scan_tools.test.ts'] },
  ),

  vibecode_workspace_info: contract(
    'Workspace info',
    'Returns repo identity, MCP server identity, tool groups, CodeGraph state, current run, and guidance.',
    'read_only',
    output('Returns bound repo root, server name/version/tool_count, grouped tool names, current run pointer, CodeGraph state, Agent Guidance status, and tool profile summaries.', ['repo_root', 'server_identity', 'tools', 'codegraph', 'current_run', 'tool_profiles']),
    { cli: ['vibecode mcp tools --json'], source: ['src/app/mcp/tools/workspace_info.ts'], tests: ['tests/app/mcp/workspace_tools.test.ts'] },
  ),
  vibecode_workspace_status: contract(
    'Workspace status',
    'Returns current read-only workspace status for the bound repo.',
    'read_only',
    output('Returns git branch/head/dirty counts, current run artifact availability, CodeGraph state, and guidance status.', ['git', 'current_run', 'codegraph', 'guidance_status']),
    { cli: ['vibecode doctor --json'], source: ['src/app/mcp/tools/workspace_status.ts'], tests: ['tests/app/mcp/workspace_tools.test.ts'] },
  ),
  vibecode_mcp_guidance: contract(
    'MCP guidance',
    'Returns effective user-editable Agent Guidance exposed through VibecodeMCP.',
    'read_only',
    output('Returns default guidance, per-tool notes, source, hash, config path, and warnings.', ['enabled', 'source', 'guidance_hash', 'default_guidance', 'per_tool_notes']),
    { cli: ['vibecode agent-guidance status --agent codex --repo <path> --json'], source: ['src/app/mcp/tools/mcp_guidance.ts'], tests: ['tests/app/mcp/guidance_tools.test.ts'] },
  ),
  vibecode_project_instructions: contract(
    'Project instructions',
    'Returns bounded allowlisted project instruction excerpts.',
    'read_only',
    output('Returns AGENTS/README/doc excerpts, source type, byte counts, and truncation flags.', ['source', 'instructions', 'docs']),
    { cli: [], source: ['src/app/mcp/tools/project_instructions.ts'], tests: ['tests/app/mcp/workspace_tools.test.ts', 'tests/app/mcp/guidance_tools.test.ts'] },
  ),
  vibecode_artifacts_list: contract(
    'Artifacts list',
    'Lists allowlisted Vibecode run artifacts before reading them.',
    'read_only',
    output('Returns artifact keys, existence, sizes, group labels, and recommendations for a selected run.', ['run_id', 'artifacts', 'exists', 'size', 'recommendation']),
    { cli: ['vibecode runs show latest --json'], source: ['src/app/mcp/tools/artifacts_list.ts'], tests: ['tests/app/mcp/workspace_tools.test.ts'] },
  ),
  vibecode_tool_profile: contract(
    'Tool profile',
    'Returns deterministic recommended MCP/CLI tool sets for common agent situations.',
    'read_only',
    output('Returns profile summaries or a full profile with MCP tools, CLI commands, next steps, and warnings.', ['profiles', 'profile', 'mcp_tools', 'cli_commands', 'warnings']),
    { cli: ['vibecode tools profile --json'], source: ['src/app/mcp/tools/tool_profile.ts'], tests: ['tests/app/mcp/tool_profile_tool.test.ts', 'tests/core/agent_guidance/tool_profiles.test.ts'] },
  ),
  vibecode_session_bootstrap: contract(
    'Session bootstrap',
    'Orient/register an agent and return runtime/recovery guidance.',
    'generated_state_write',
    output('Returns repo/session/git/run/artifact/agent/claim/conflict/evidence/instruction awareness, runtime_awareness, recovery guidance, and recommended next tools/commands.', ['repo', 'server_identity', 'agent', 'git', 'claims', 'conflicts', 'runtime_awareness', 'recovery', 'recommended_next_tools']),
    {
      cli: ['vibecode session bootstrap --json'],
      safety: [
        'May register a new agent or heartbeat an existing agent when called with register or agent_id arguments.',
        'Does not edit source files, mutate git, transfer ownership, release claims, reap stale claims, or resolve conflicts.',
      ],
      source: ['src/app/mcp/tools/session_bootstrap.ts'],
      tests: ['tests/app/mcp/session_bootstrap_tool.test.ts', 'tests/app/mcp/phase1a_enforcement.test.ts'],
    },
  ),
  vibecode_git_changes: contract(
    'Git changes',
    'Returns claim-aware changed-file and diff-stat awareness.',
    'read_only',
    output('Returns changed file counts/classification, bounded file samples, diff stat, claim classification, warnings, blockers, and recommended next commands.', ['counts', 'files', 'diff_stat', 'claim_classification', 'warnings', 'blockers']),
    { cli: ['vibecode git changes --json'], source: ['src/app/mcp/tools/git_changes.ts'], tests: ['tests/app/mcp/git_changes_tool.test.ts'] },
  ),

  vibecode_coordination_status: contract(
    'Coordination status',
    'Summarizes advisory multi-agent coordination state.',
    'read_only',
    output('Returns counts and samples for agents, claims, conflicts, handoffs, and generated coordination state.', ['workspace_root', 'summary', 'agents', 'claims', 'conflicts']),
    { cli: ['vibecode coordination status --json'], source: ['src/app/mcp/tools/coordination_status.ts'], tests: ['tests/app/mcp/coordination_tools.test.ts'] },
  ),
  vibecode_agent_register: contract(
    'Agent register',
    'Registers a persistent advisory agent session.',
    'coordination_write',
    output('Returns the created agent session, agent id, lifecycle metadata, and computed active status.', ['agent', 'agent_id', 'status']),
    { cli: ['vibecode agents register --json'], source: ['src/app/mcp/tools/agents.ts'], tests: ['tests/app/mcp/agent_tools.test.ts'] },
  ),
  vibecode_agent_heartbeat: contract(
    'Agent heartbeat',
    'Records a heartbeat for an existing agent session.',
    'coordination_write',
    output('Returns heartbeat timestamp, stale revival flag, updated agent record, and lifecycle status.', ['agent', 'heartbeat_at', 'was_stale', 'status']),
    { cli: ['vibecode agents heartbeat --agent <agent_id> --json'], source: ['src/app/mcp/tools/agents.ts'], tests: ['tests/app/mcp/agent_tools.test.ts'] },
  ),
  vibecode_agents_list: contract(
    'Agents list',
    'Lists registered agent sessions with computed stale-aware status.',
    'read_only',
    output('Returns agent records, lifecycle/status fields, heartbeat timestamps, and metadata.', ['agents', 'agent_id', 'status', 'last_heartbeat_at']),
    { cli: ['vibecode agents list --json'], source: ['src/app/mcp/tools/agents.ts'], tests: ['tests/app/mcp/agent_tools.test.ts'] },
  ),
  vibecode_agent_status: contract(
    'Agent status',
    'Returns one registered agent session by id.',
    'read_only',
    output('Returns the matching agent record and computed lifecycle/status.', ['agent', 'agent_id', 'status']),
    { cli: ['vibecode agents status --agent <agent_id> --json'], source: ['src/app/mcp/tools/agents.ts'], tests: ['tests/app/mcp/agent_tools.test.ts'] },
  ),
  vibecode_claim_add: contract(
    'Claim add',
    'Creates one advisory file claim for an active agent.',
    'coordination_write',
    output('Returns created claim detail or a structured claim-denied/conflict diagnostic.', ['claim', 'claim_id', 'status', 'conflict']),
    { cli: ['vibecode claims add --agent <agent_id> --path <path> --json'], source: ['src/app/mcp/tools/claims.ts'], tests: ['tests/app/mcp/claim_tools.test.ts'] },
  ),
  vibecode_claims_list: contract(
    'Claims list',
    'Lists advisory file claims with stale-aware status.',
    'read_only',
    output('Returns claims with owner agent, path, mode, status, timestamps, and optional released entries.', ['claims', 'claim_id', 'path', 'agent_id', 'status']),
    { cli: ['vibecode claims list --json'], source: ['src/app/mcp/tools/claims.ts'], tests: ['tests/app/mcp/claim_tools.test.ts'] },
  ),
  vibecode_claim_status: contract(
    'Claim status',
    'Shows advisory claim status for one repo-relative path.',
    'read_only',
    output('Returns active/stale/released claim detail for the requested path and conflict status.', ['path', 'claims', 'status']),
    { cli: ['vibecode claims status --path <path> --json'], source: ['src/app/mcp/tools/claims.ts'], tests: ['tests/app/mcp/claim_tools.test.ts'] },
  ),
  vibecode_claim_release: contract(
    'Claim release',
    'Releases one advisory file claim.',
    'coordination_write',
    output('Returns the released claim record and updated status.', ['claim', 'claim_id', 'status']),
    { cli: ['vibecode claims release --claim <claim_id> --json'], source: ['src/app/mcp/tools/claims.ts'], tests: ['tests/app/mcp/claim_tools.test.ts'] },
  ),
  vibecode_claims_plan: contract(
    'Claims plan',
    'Evaluates whether explicit paths can be claimed without creating claims.',
    'read_only',
    output('Returns per-path classifications such as claimable, owned, blocked, stale, generated, missing, or invalid, plus an add-bulk recommendation.', ['paths', 'results', 'claimable', 'blocked', 'recommended_command']),
    { cli: ['vibecode claims plan --agent <agent_id> --path <path> --json'], source: ['src/app/mcp/tools/claims_bulk.ts'], tests: ['tests/app/mcp/claims_bulk_tools.test.ts'] },
  ),
  vibecode_claims_add_bulk: contract(
    'Claims add bulk',
    'Creates an atomic explicit-path work intent and claims its paths.',
    'coordination_write',
    output('Returns the created/extended intent, claimed paths, skipped already-owned paths, and conflict diagnostics.', ['intent', 'intent_id', 'claims', 'blocked_paths']),
    { cli: ['vibecode claims add-bulk --agent <agent_id> --intent "<intent>" --path <path> --json'], source: ['src/app/mcp/tools/claims_bulk.ts'], tests: ['tests/app/mcp/claims_bulk_tools.test.ts'] },
  ),
  vibecode_claim_intents_list: contract(
    'Claim intents list',
    'Lists work intents with claim detail and owner lifecycle status.',
    'read_only',
    output('Returns intents, active/released claim counts, paths, owner status, and releasability hints.', ['intents', 'intent_id', 'claims', 'owner_status']),
    { cli: ['vibecode claims intents list --json'], source: ['src/app/mcp/tools/claim_intent_lifecycle.ts'], tests: ['tests/app/mcp/claim_intent_lifecycle_tools.test.ts'] },
  ),
  vibecode_claim_intent_release: contract(
    'Claim intent release',
    'Releases all active clean claims belonging to one same-agent work intent.',
    'coordination_write',
    output('Returns dry-run/apply mode, released claims, blocked dirty paths, and updated intent status.', ['intent', 'released_claims', 'blocked_dirty_paths', 'dry_run']),
    {
      cli: ['vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json'],
      safety: [
        'Same-agent only; never releases another agent intent.',
        'Blocks when claimed files are dirty; commit or revert first.',
        'Supports dry_run for previewing the generated-state write.',
      ],
      source: ['src/app/mcp/tools/claim_intent_lifecycle.ts'],
      tests: ['tests/app/mcp/claim_intent_lifecycle_tools.test.ts'],
    },
  ),
  vibecode_finalize_check: contract(
    'Finalize check',
    'Classifies dirty working-tree files against an agent active claims.',
    'read_only',
    output('Returns ok/warning/blocked status, changed file classifications, blockers/warnings, and exact commit guard command recommendations when safe.', ['status', 'classifications', 'blockers', 'warnings', 'recommended_cli_commands']),
    { cli: ['vibecode finalize check --agent <agent_id> --json'], source: ['src/app/mcp/tools/finalize_check.ts'], tests: ['tests/app/mcp/finalize_tool.test.ts'] },
  ),
  vibecode_evidence_list: contract(
    'Evidence list',
    'Lists advisory watcher evidence events.',
    'read_only',
    output('Returns recent evidence events, warning/high counts, paths, classifications, and timestamps.', ['events', 'classification', 'path', 'severity']),
    { cli: ['vibecode evidence list --json'], source: ['src/app/mcp/tools/evidence.ts'], tests: ['tests/app/mcp/evidence_tools.test.ts'] },
  ),
  vibecode_evidence_scan: contract(
    'Evidence scan',
    'Scans the dirty git tree into generated advisory evidence.',
    'coordination_write',
    output('Returns newly recorded evidence events and dirty-file classifications.', ['events', 'changed_files', 'classification']),
    {
      cli: ['vibecode evidence scan --agent <agent_id> --json'],
      safety: ['Writes only generated evidence events under .vibecode/coordination; no git/source mutation and no file watching loop is started.'],
      source: ['src/app/mcp/tools/evidence.ts'],
      tests: ['tests/app/mcp/evidence_tools.test.ts'],
    },
  ),
  vibecode_claims_reap: contract(
    'Claims reap',
    'Explicitly releases claims owned by stale or terminated agents.',
    'coordination_write',
    output('Returns stale claims eligible for reaping, reaped claims, dry-run/apply mode, and warnings.', ['stale_claims', 'reaped_claims', 'dry_run', 'mode']),
    {
      cli: ['vibecode claims reap --dry-run --json'],
      safety: ['Generated coordination cleanup only; dry-run first is recommended and no source/git mutation occurs.'],
      source: ['src/app/mcp/tools/claims.ts'],
      tests: ['tests/app/mcp/conflict_tools.test.ts'],
    },
  ),
  vibecode_conflicts_list: contract(
    'Conflicts list',
    'Lists recorded coordination conflicts.',
    'read_only',
    output('Returns conflict records, status, type, involved agents/files/claims, and triage metadata.', ['conflicts', 'conflict_id', 'status', 'conflict_type']),
    { cli: ['vibecode conflicts list --json'], source: ['src/app/mcp/tools/conflicts.ts'], tests: ['tests/app/mcp/conflict_tools.test.ts'] },
  ),
  vibecode_conflict_resolve: contract(
    'Conflict resolve',
    'Marks one generated coordination conflict as resolved.',
    'coordination_write',
    output('Returns the updated conflict record and resolved status.', ['conflict', 'conflict_id', 'status']),
    { cli: ['vibecode conflicts resolve --conflict-id <conflict_id> --json'], source: ['src/app/mcp/tools/conflicts.ts'], tests: ['tests/app/mcp/conflict_tools.test.ts'] },
  ),
  vibecode_conflict_detail: contract(
    'Conflict detail',
    'Returns intent-aware triage detail for one conflict.',
    'read_only',
    output('Returns blocking claim/intent, owner lifecycle, warning codes, safe next-step recommendations, and involved paths.', ['conflict', 'blocking_claim', 'blocking_intent', 'owner_lifecycle', 'warning_codes']),
    { cli: ['vibecode conflicts detail --conflict-id <conflict_id> --json'], source: ['src/app/mcp/tools/conflicts.ts'], tests: ['tests/app/mcp/conflict_tools.test.ts'] },
  ),
  vibecode_handoff_prepare: contract(
    'Handoff prepare',
    'Builds a bounded read-only handoff packet for a stopping agent.',
    'read_only',
    output('Returns one handoff_state, owned active claims/intents, dirty claimed files, shared-tree blockers, required-before-handoff actions, safe commands, next-agent registration commands, and do_not_do boundaries.', ['agent_id', 'handoff_state', 'handoff_ready', 'owned_claims', 'required_before_handoff', 'safe_commands', 'do_not_do']),
    {
      cli: ['vibecode handoff prepare --agent <agent_id> --json'],
      safety: [
        'Read-only handoff visibility only; never transfers claims, assigns the next agent, releases, reaps, resolves, heartbeats, edits source, or mutates git.',
        'Next agent must register separately and claim exact files after the previous agent releases them.',
      ],
      source: ['src/app/mcp/tools/handoff_prepare.ts', 'src/core/agent_session/handoff_packet.ts'],
      tests: ['tests/app/mcp/handoff_tool.test.ts', 'tests/core/agent_session/handoff_packet.test.ts'],
    },
  ),
  vibecode_handoff_guide: contract(
    'Handoff guide',
    'Builds read-only next-agent onboarding guidance from a previous agent handoff state.',
    'read_only',
    output('Returns one onboarding_state, previous-agent handoff source summary, next-agent lifecycle, blocked paths, paths requiring new claims after release, separated previous/next safe commands, and do_not_do boundaries.', ['from_agent_id', 'for_agent_id', 'onboarding_state', 'can_continue_now', 'ownership_transferred', 'blocked_paths', 'next_agent_cli_commands', 'do_not_do']),
    {
      cli: ['vibecode handoff guide --from-agent <from_agent_id> --for-agent <for_agent_id> --json'],
      safety: [
        'Read-only guidance only; never transfers ownership, registers, heartbeats, claims, releases, reaps, resolves, edits source, or mutates git.',
        'No ownership transfer: the next agent must register separately and claim exact files explicitly.',
      ],
      source: ['src/app/mcp/tools/handoff_guide.ts', 'src/core/agent_session/handoff_guide.ts'],
      tests: ['tests/app/mcp/handoff_guide_tool.test.ts', 'tests/core/agent_session/handoff_guide.test.ts'],
    },
  ),
  vibecode_team_status: contract(
    'Team status',
    'Read-only team overview for multi-agent coordination: all agents with status, claims, intents, conflicts, and safe next commands.',
    'read_only',
    output('Returns a bounded team status overview with summary counts, per-agent recommended actions, workspace state, claims/intents/conflict samples, stale coordination state, and safe next commands.', ['summary', 'agents', 'claims', 'intents', 'conflicts', 'stale_coordination', 'recommended_next_tools', 'recommended_cli_commands']),
    {
      cli: ['vibecode team status --json'],
      safety: [
        'Read-only observability and guidance only; never assigns work, transfers ownership, auto-claims, auto-releases, auto-reaps, auto-resolves, or mutates git/source/coordination state.',
        'No assignment: team status does not choose which agent continues. The human or external process decides.',
      ],
      source: ['src/app/mcp/tools/team_status.ts', 'src/core/agent_session/team_status.ts'],
      tests: ['tests/app/mcp/team_status_tool.test.ts', 'tests/core/agent_session/team_status.test.ts'],
    },
  ),
});

function buildToolToGroup(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [group, names] of Object.entries(AGENT_GUIDANCE_MCP_TOOL_GROUPS)) {
    for (const name of names) out.set(name, group);
  }
  return out;
}

function buildProfilesByTool(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const profile of listToolProfiles()) {
    for (const tool of profile.mcp_tools) {
      const current = out.get(tool.name) ?? [];
      current.push(profile.profile_id);
      out.set(tool.name, current);
    }
  }
  return out;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const idx = trimmed.indexOf('.');
  return idx >= 0 ? trimmed.slice(0, idx + 1) : trimmed;
}

function makeItem(
  registryTool: McpToolDefinition,
  group: string,
  metadata: McpToolContractMetadata,
  profiles: string[],
): McpToolCatalogItem {
  return {
    name: registryTool.name,
    title: metadata.title,
    group,
    summary: metadata.summary,
    description: metadata.description ?? registryTool.description,
    side_effect: metadata.side_effect,
    input_schema: registryTool.inputSchema,
    output_contract: metadata.output_contract,
    cli_equivalents: [...(metadata.cli_equivalents ?? [])],
    profiles: [...profiles],
    safety_notes: [...metadata.safety_notes],
    source_files: [...metadata.source_files],
    test_files: [...metadata.test_files],
  };
}

export function getMcpToolCatalog(): McpToolCatalog {
  const registryTools = buildVibecodeMcpTools();
  const registryNames = registryTools.map((tool) => tool.name);
  const registryNameSet = new Set(registryNames);
  const toolToGroup = buildToolToGroup();
  const profilesByTool = buildProfilesByTool();
  const warnings: string[] = [];

  for (const name of registryNames) {
    if (!MCP_TOOL_CONTRACTS[name]) warnings.push(`MISSING_TOOL_CONTRACT: ${name}`);
    if (!toolToGroup.has(name)) warnings.push(`MISSING_TOOL_GROUP: ${name}`);
  }
  for (const name of Object.keys(MCP_TOOL_CONTRACTS)) {
    if (!registryNameSet.has(name)) warnings.push(`UNKNOWN_TOOL_CONTRACT: ${name}`);
  }

  const tools = registryTools.map((tool) => {
    const fallbackMetadata = contract(
      tool.title ?? tool.name,
      firstSentence(tool.description),
      'unknown',
      output('Returns the standard MCP structuredContent envelope for this tool.', ['data']),
      {
        safety: ['Catalog metadata is incomplete for this tool.'],
        source: ['src/app/mcp/tool_registry.ts'],
        tests: ['tests/app/mcp/tool_registry.test.ts'],
      },
    );
    return makeItem(
      tool,
      toolToGroup.get(tool.name) ?? 'unknown',
      MCP_TOOL_CONTRACTS[tool.name] ?? fallbackMetadata,
      profilesByTool.get(tool.name) ?? [],
    );
  });

  const groupedInRegistryOrder = new Map<string, string[]>();
  for (const name of registryNames) {
    const group = toolToGroup.get(name) ?? 'unknown';
    const current = groupedInRegistryOrder.get(group) ?? [];
    current.push(name);
    groupedInRegistryOrder.set(group, current);
  }
  const groupObjects = [...groupedInRegistryOrder.entries()].map(([id, names]) => ({
    id,
    title: GROUP_TITLES[id] ?? id,
    tool_names: names,
  }));

  return {
    tool_count: registryTools.length,
    generated_from: { registry: true, schemas: true, profiles: true },
    groups: groupObjects,
    tools,
    warnings,
  };
}

export function getMcpToolDetail(name: string): McpToolCatalogItem | null {
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  return getMcpToolCatalog().tools.find((tool) => tool.name === name) ?? null;
}
