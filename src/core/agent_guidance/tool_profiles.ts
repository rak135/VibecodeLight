/**
 * Phase 1B-3 — tool profiles / recommended tool sets.
 *
 * Agents now have 30+ MCP tools and a matching CLI surface. Choosing the right
 * tool for a situation is itself friction, and friction is what pushes agents
 * back to raw `rg` / `git`. Tool profiles are small, named, DETERMINISTIC
 * bundles of the recommended VibecodeMCP tools and CLI commands for a common
 * agent situation ("I am about to edit", "I just edited", "I hit a claim
 * conflict"). They add no new power — they only make the existing safe path
 * obvious and short.
 *
 * Design constraints (intentional non-goals are enforced by tests, not config):
 *   - static / deterministic — NO LLM ranking, NO task-aware relevance scoring;
 *   - bounded — short, fixed lists an agent can read in one glance;
 *   - read-only — this module declares data and pure functions; it never reads
 *     the filesystem, runs the scanner, executes a shell, or mutates anything;
 *   - decoupled — profiles reference MCP tool names as plain strings. The test
 *     suite (not this module) cross-checks every name against the canonical MCP
 *     registry so a renamed/removed tool fails CI. Core never imports the app
 *     layer.
 *
 * The MCP tool `vibecode_tool_profile` and the CLI `vibecode tools profile`
 * command are thin adapters over {@link listToolProfiles} / {@link getToolProfile}
 * so MCP and CLI return identical data. `session_bootstrap` and `workspace_info`
 * surface profile ids/recommendations (not full profiles) so the safe path is
 * visible without dumping every profile.
 */

/** Stable, ordered set of profile ids. */
export const TOOL_PROFILE_IDS = [
  'read_only_orientation',
  'build_pre_edit',
  'build_post_edit',
  'scan_inspection',
  'artifact_continuation',
  'safe_commit',
  'conflict_resolution',
  'coordination_housekeeping',
  'runtime_preflight',
  'session_recovery',
  'team_handoff',
] as const;

export type ToolProfileId = (typeof TOOL_PROFILE_IDS)[number];

/** One recommended MCP tool within a profile. */
export interface ToolProfileMcpTool {
  /** Canonical MCP tool name (must exist in the registry — tested). */
  name: string;
  /** Short reason this tool belongs in this profile. */
  reason: string;
}

/** One recommended CLI command within a profile. CLI fallback for the MCP tool. */
export interface ToolProfileCliCommand {
  /**
   * Template command string. `<...>` segments are placeholders the agent fills
   * in (agent id, path, message, …). Comma-valued flags are pre-quoted for
   * PowerShell/pnpm reliability.
   */
  command: string;
  /** Short reason to run this command. */
  reason: string;
}

/** A full tool profile: a bounded, deterministic recommended tool set. */
export interface ToolProfile {
  profile_id: ToolProfileId;
  title: string;
  purpose: string;
  when_to_use: string[];
  mcp_tools: ToolProfileMcpTool[];
  cli_commands: ToolProfileCliCommand[];
  next_steps: string[];
  warnings: string[];
}

/** Compact one-line view of a profile for list responses / orientation. */
export interface ToolProfileSummary {
  profile_id: ToolProfileId;
  title: string;
  purpose: string;
}

/** A context-aware profile recommendation: an id plus a short reason. */
export interface ToolProfileRecommendation {
  profile_id: ToolProfileId;
  reason: string;
}

const PROFILES: Readonly<Record<ToolProfileId, ToolProfile>> = Object.freeze({
  read_only_orientation: {
    profile_id: 'read_only_orientation',
    title: 'Read-only orientation',
    purpose: 'Inspect and understand the repo without editing anything.',
    when_to_use: [
      'You are a read_only agent, or you have not registered yet.',
      'You are reviewing, debugging, or answering a question about the repo.',
    ],
    mcp_tools: [
      { name: 'vibecode_session_bootstrap', reason: 'One-call orientation: git/run/agents/claims/scan/codegraph + recommended next tools.' },
      { name: 'vibecode_workspace_info', reason: 'Bound repo path, available tools, CodeGraph status, current run.' },
      { name: 'vibecode_project_instructions', reason: 'Bounded AGENTS.md/README/codegraph instruction excerpts.' },
      { name: 'vibecode_git_changes', reason: 'Read-only changed-files summary (no full diff, no mutation).' },
      { name: 'vibecode_scan_summary', reason: 'Compact counts/samples from existing scan artifacts.' },
      { name: 'vibecode_scan_artifact_read', reason: 'Read one allowlisted scan artifact in bounded chunks.' },
      { name: 'vibecode_artifacts_list', reason: 'List allowlisted run artifacts before reading them.' },
      { name: 'vibecode_artifact_read', reason: 'Read one allowlisted run artifact in bounded, continuation-friendly chunks.' },
    ],
    cli_commands: [
      { command: 'vibecode session bootstrap --register --agent-mode read_only --task "<task>" --json', reason: 'Register a read-only session and orient in one call.' },
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for the read-only changed-files summary.' },
      { command: 'vibecode scan summary --run current --json', reason: 'CLI fallback for the scan summary.' },
      { command: 'vibecode scan artifact-read --run current --artifact <artifact> --json', reason: 'CLI fallback to read one scan artifact.' },
      { command: 'vibecode runs artifact-read --run current --artifact <artifact> --json', reason: 'CLI fallback to read one run artifact.' },
    ],
    next_steps: [
      'If you discover you must edit files, re-register as a build agent (agent_mode=build) and switch to build_pre_edit.',
    ],
    warnings: [
      'read_only agents must NOT modify source files and cannot claim files.',
    ],
  },
  build_pre_edit: {
    profile_id: 'build_pre_edit',
    title: 'Build agent before editing',
    purpose: 'Orient and claim files before modifying anything.',
    when_to_use: [
      'You are a build agent and have not yet edited (no claimed dirty files).',
      'You are about to start changing source files.',
    ],
    mcp_tools: [
      { name: 'vibecode_session_bootstrap', reason: 'Confirm identity and see active agents/claims/conflicts before editing.' },
      { name: 'vibecode_git_changes', reason: 'Check claim-aware dirty state before editing.' },
      { name: 'vibecode_scan_summary', reason: 'Find relevant commands/tests/files/symbols from existing scan artifacts.' },
      { name: 'vibecode_scan_artifact_read', reason: 'Drill into one scan artifact for detail.' },
      { name: 'vibecode_claims_plan', reason: 'After researching the task, declare your intended files and preview whether they can be claimed (read-only).' },
      { name: 'vibecode_claims_add_bulk', reason: 'Claim your declared files as one atomic work intent before editing.' },
      { name: 'vibecode_claim_add', reason: 'Single-file fallback: claim one more file before editing it.' },
      { name: 'vibecode_claims_list', reason: 'See current claims to avoid overlapping another agent.' },
      { name: 'vibecode_project_instructions', reason: 'Re-read the repo working agreement before changing it.' },
    ],
    cli_commands: [
      { command: 'vibecode session bootstrap --register --agent-mode build --task "<task>" --json', reason: 'Register a build session and orient in one call.' },
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for claim-aware dirty state.' },
      { command: 'vibecode claims plan --agent <agent_id> --path <path> --json', reason: 'Preview whether your declared files can be claimed (read-only).' },
      { command: 'vibecode claims add-bulk --agent <agent_id> --intent "<intent>" --path <path> --json', reason: 'Claim your declared files as one work intent.' },
      { command: 'vibecode claims add --agent <agent_id> --path <path> --json', reason: 'Single-file fallback to claim one more file.' },
      { command: 'vibecode claims list --json', reason: 'CLI fallback to inspect current claims.' },
    ],
    next_steps: [
      'Research the task FIRST, then declare your explicit files — Vibecode does not choose them for you.',
      'After editing, switch to build_post_edit to validate and prepare a guarded commit.',
    ],
    warnings: [
      'Claim each file before editing it; edit only files your agent has claimed.',
      'Declare explicit paths only — no globs, directories, or inference. Vibecode coordinates the scope you declare; it does not decide it.',
      'npm/pnpm/yarn install or dependency changes can modify a lockfile (e.g. package-lock.json). Claim the lockfile (claims add-bulk --intent-id <id> --path package-lock.json) before finalize if you changed it on purpose; revert it before finalize if it changed by accident.',
    ],
  },
  build_post_edit: {
    profile_id: 'build_post_edit',
    title: 'Build agent after editing',
    purpose: 'Validate your changes and prepare a safe, scoped commit.',
    when_to_use: [
      'You are a build agent that has edited files and is heading toward commit.',
      'You want to confirm only your claimed files are dirty.',
    ],
    mcp_tools: [
      { name: 'vibecode_git_changes', reason: 'Confirm which dirty files are yours vs another agent / unclaimed.' },
      { name: 'vibecode_finalize_check', reason: 'Read-only finalize: classify the working tree against your claims before commit.' },
      { name: 'vibecode_claims_add_bulk', reason: 'If finalize flags an unclaimed file you meant to change, claim it explicitly (extend your intent) before committing.' },
      { name: 'vibecode_claims_list', reason: 'Verify your claims still cover everything you changed.' },
      { name: 'vibecode_claim_intents_list', reason: 'See your active work intents and their claim counts.' },
    ],
    cli_commands: [
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for claim-aware dirty state.' },
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for the finalize check; returns the recommended commit guard command.' },
      { command: 'vibecode claims add-bulk --agent <agent_id> --intent-id <intent_id> --path <path> --json', reason: 'Claim a file finalize flagged as unclaimed (only if you meant to change it).' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview exactly which files the guard would stage (no staging/commit).' },
      { command: 'vibecode commit guard --agent <agent_id> --message "<message>" --json', reason: 'Commit ONLY your claimed files through the guard.' },
    ],
    next_steps: [
      'If finalize blocks on an unclaimed file: claim it explicitly if you meant to change it, or revert it if it changed by accident.',
      'If finalize blocks only on unrelated unclaimed dirty files you never touched, commit guard can still make an isolated commit that skips them — never stage or commit them yourself.',
      'When finalize is ok, use safe_commit (commit guard is CLI-only).',
      'After a successful commit and clean tree, release your completed work intent.',
    ],
    warnings: [
      'Commit through `vibecode commit guard` — never raw git add/commit.',
      'Commit guard is intentionally CLI-only; there is no MCP commit tool.',
      'A lockfile (e.g. package-lock.json) changed by an install can block finalize. Claim it if the change is intentional, or revert it if it is accidental, before committing.',
      'Do not release a work intent while its claimed files are still dirty.',
    ],
  },
  scan_inspection: {
    profile_id: 'scan_inspection',
    title: 'Scan artifact inspection',
    purpose: 'Use deterministic scanner intelligence to orient on the repo.',
    when_to_use: [
      'A scan is available for the current run (scan_available=true).',
      'You want commands/tests/files/symbols/imports without raw grep.',
    ],
    mcp_tools: [
      { name: 'vibecode_scan_summary', reason: 'Per-section counts and top items across the scan artifacts.' },
      { name: 'vibecode_scan_artifact_read', reason: 'Read one allowlisted scan artifact in full, in bounded chunks.' },
      { name: 'vibecode_artifact_read', reason: 'Read run output artifacts (final_prompt, context_pack, …) for context.' },
      { name: 'vibecode_project_instructions', reason: 'Pair scan facts with the repo working agreement.' },
    ],
    cli_commands: [
      { command: 'vibecode scan summary --run current --sections "files,commands,tests,symbols" --json', reason: 'CLI fallback for a focused scan summary (comma-valued flag is quoted).' },
      { command: 'vibecode scan artifact-read --run current --artifact <artifact> --json', reason: 'CLI fallback to read one scan artifact.' },
      { command: 'vibecode runs artifact-read --run current --artifact <artifact> --json', reason: 'CLI fallback to read one run artifact.' },
    ],
    next_steps: [
      'For a large artifact, follow next_byte_offset until has_more=false (see artifact_continuation).',
    ],
    warnings: [
      'These tools READ existing scan artifacts; they never run the scanner.',
    ],
  },
  artifact_continuation: {
    profile_id: 'artifact_continuation',
    title: 'Large artifact continuation',
    purpose: 'Read large run or scan artifacts fully without partial-context traps.',
    when_to_use: [
      'An artifact is larger than one chunk (has_more=true).',
      'You must reconstruct a full final_prompt / context_pack / scan artifact.',
    ],
    mcp_tools: [
      { name: 'vibecode_artifact_read', reason: 'Byte-offset continuation read of a run artifact (UTF-8-safe, full-file hash).' },
      { name: 'vibecode_scan_artifact_read', reason: 'Same continuation contract for an allowlisted scan artifact.' },
      { name: 'vibecode_artifacts_list', reason: 'Confirm which artifacts exist before paging them.' },
    ],
    cli_commands: [
      { command: 'vibecode runs artifact-read --run current --artifact <artifact> --byte-offset 0 --max-bytes 16000 --json', reason: 'Start a chunked run-artifact read; then pass next_byte_offset.' },
      { command: 'vibecode scan artifact-read --run current --artifact <artifact> --byte-offset 0 --max-bytes 16000 --json', reason: 'Start a chunked scan-artifact read; then pass next_byte_offset.' },
    ],
    next_steps: [
      'Repeat with byte_offset = next_byte_offset until has_more=false; concatenate chunks to reconstruct the file.',
    ],
    warnings: [
      'Chain from next_byte_offset (always a valid UTF-8 boundary), not arbitrary offsets.',
    ],
  },
  safe_commit: {
    profile_id: 'safe_commit',
    title: 'Safe scoped commit',
    purpose: 'Commit only your claimed files through the guard.',
    when_to_use: [
      'You are a build agent ready to commit.',
      'Finalize is ok/warning with committable claimed files.',
    ],
    mcp_tools: [
      { name: 'vibecode_git_changes', reason: 'Final claim-aware check of what is dirty.' },
      { name: 'vibecode_finalize_check', reason: 'Confirm finalize is not blocked; it returns the exact commit guard command.' },
      { name: 'vibecode_claims_list', reason: 'Confirm your claims cover the files you intend to commit.' },
      { name: 'vibecode_claim_intents_list', reason: 'See your active work intents before releasing.' },
      { name: 'vibecode_claim_intent_release', reason: 'Release a completed intent after a successful commit and clean tree.' },
    ],
    cli_commands: [
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for the final dirty-state check.' },
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for the finalize gate.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview the scoped commit (no staging/commit).' },
      { command: 'vibecode commit guard --agent <agent_id> --message "<message>" --json', reason: 'Commit ONLY your claimed files through the guard.' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json', reason: 'Preview intent release (confirm clean tree).' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --json', reason: 'Release the completed work intent after commit.' },
    ],
    next_steps: [
      'Run git changes and finalize check before committing, then dry-run the guard and inspect skipped files/warnings.',
      'In a shared dirty tree the guard may make an isolated commit: it stages ONLY your claimed files and skips unrelated unclaimed dirty files with an UNCLAIMED_DIRTY_FILES_SKIPPED warning. Skipped files stay dirty after the commit.',
      'After a successful guarded commit, release your completed work intent.',
      'Dry-run intent release first to confirm the tree is clean.',
      'Do not release while claimed files are dirty.',
    ],
    warnings: [
      'Commit mutation is CLI-only by design; there is no MCP commit tool.',
      'If the guard blocks with STAGED_UNCLAIMED_FILES_BLOCKED or GIT_INDEX_NOT_CLEAN, unstage and review those files yourself — never commit them and never manually stage unrelated files.',
      'An isolated commit is not cleanup, not ownership transfer, and not permission to edit unclaimed files.',
      'Do not bypass the commit guard with raw git add/commit unless a human explicitly directs it.',
      'The guard never stages broad paths and leaves other agents\u2019 files untouched.',
      'A lockfile (e.g. package-lock.json) changed by an install can block finalize. Claim it if the change is intentional, or revert it if it is accidental, before committing.',
      'Do not release another agent\u2019s intent — release is same-agent only.',
    ],
  },
  conflict_resolution: {
    profile_id: 'conflict_resolution',
    title: 'Claim conflict resolution',
    purpose: 'Inspect and resolve overlapping claims or recorded conflicts with intent-aware triage.',
    when_to_use: [
      'A claim was denied, or there are unresolved conflicts / possibly-stale claims.',
      'Two agents are competing for the same file.',
      'Bootstrap reports still-blocking or stale-blocking conflicts.',
    ],
    mcp_tools: [
      { name: 'vibecode_conflicts_list', reason: 'List recorded coordination conflicts with triage status.' },
      { name: 'vibecode_conflict_detail', reason: 'Get full triage detail: blocking claim/intent, owner lifecycle, warning codes, safe next steps.' },
      { name: 'vibecode_claims_list', reason: 'See all claims with stale-aware status to find the overlap.' },
      { name: 'vibecode_session_bootstrap', reason: 'Re-orient on active agents/claims/conflicts before acting.' },
      { name: 'vibecode_git_changes', reason: 'Check whether the contested files are actually dirty.' },
      { name: 'vibecode_claim_intents_list', reason: 'See work intents with owner lifecycle status to understand the blocking scope.' },
    ],
    cli_commands: [
      { command: 'vibecode conflicts list --json', reason: 'CLI fallback to inspect recorded conflicts.' },
      { command: 'vibecode conflicts detail --conflict-id <conflict_id> --json', reason: 'CLI fallback for full triage detail on one conflict.' },
      { command: 'vibecode claims list --json', reason: 'CLI fallback to inspect overlapping claims.' },
      { command: 'vibecode claims intents list --status active --json', reason: 'CLI fallback to see active intents and owner lifecycle.' },
      { command: 'vibecode session bootstrap --agent <agent_id> --json', reason: 'Re-orient (heartbeat) and see the current conflict state.' },
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback to check whether contested files are dirty.' },
    ],
    next_steps: [
      'If the blocker is your own claim/intent: finish/commit/revert, then release your own clean intent.',
      'If the blocker belongs to another active agent: do not edit the file, choose another task/path, or coordinate externally.',
      'If the blocker owner is stale: use coordination_housekeeping and claims reap dry-run. Do not force release another agent\'s intent.',
      'If the conflict is no longer blocking (claims released): re-run claims plan/add-bulk.',
    ],
    warnings: [
      'Do not edit a file whose claim was denied; coordination is advisory but overlapping edits cause lost work.',
      'Do not release another agent\'s intent — release is same-agent only.',
      'No force or automatic cleanup exists; claims reap is explicit and dry-run-first.',
    ],
  },
  coordination_housekeeping: {
    profile_id: 'coordination_housekeeping',
    title: 'Coordination housekeeping',
    purpose: 'Keep your session fresh and inspect/clean up stale coordination state with explicit, bounded commands.',
    when_to_use: [
      'session_bootstrap reports stale agents, stale claims, or stale-owned intents.',
      'You are in a long session and want to keep your agent from going stale.',
    ],
    mcp_tools: [
      { name: 'vibecode_agent_heartbeat', reason: 'Heartbeat your own agent during long work so it does not go stale (no re-bootstrap needed).' },
      { name: 'vibecode_session_bootstrap', reason: 'Re-orient: the stale_coordination summary shows what is stale and what to do.' },
      { name: 'vibecode_claim_intents_list', reason: 'See work intents with owner lifecycle status (active/stale/terminated/missing).' },
      { name: 'vibecode_claims_list', reason: 'Inspect all claims with stale-aware status before any cleanup.' },
      { name: 'vibecode_claims_reap', reason: 'Explicitly release claims of stale/terminated agents — dry-run first; never automatic.' },
      { name: 'vibecode_claim_intent_release', reason: 'Release YOUR OWN completed clean intents only (same-agent only).' },
    ],
    cli_commands: [
      { command: 'vibecode agents heartbeat --agent <agent_id> --json', reason: 'CLI fallback to keep your own session alive during long work.' },
      { command: 'vibecode claims intents list --agent <agent_id> --status active --json', reason: 'CLI fallback to inspect your active intents and their claim/owner status.' },
      { command: 'vibecode claims list --json', reason: 'CLI fallback to inspect all claims before cleanup.' },
      { command: 'vibecode claims reap --dry-run --json', reason: 'Preview which stale-agent claims an explicit reap would release.' },
      { command: 'vibecode claims reap --json', reason: 'Explicitly release stale-agent claims after reviewing the dry-run.' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json', reason: 'Preview releasing one of your OWN clean intents.' },
    ],
    next_steps: [
      'Heartbeat your own agent, inspect claims/intents, dry-run a reap, and only then apply explicit cleanup.',
      'Release by intent only for your own clean intents; leave other agents’ intents alone.',
    ],
    warnings: [
      'Never release another agent’s intent — intent release is same-agent only.',
      'No force or automatic cleanup exists: claims reap is explicit and dry-run-first.',
      'Do not edit unclaimed files while housekeeping.',
      'Never edit .vibecode/coordination/state.json by hand — use the commands above.',
      'Use the CLI fallback commands when MCP is unavailable.',
    ],
  },
  runtime_preflight: {
    profile_id: 'runtime_preflight',
    title: 'Runtime preflight',
    purpose: 'Verify your session, MCP server, and shared-tree state before editing, committing, or continuing after long-running work.',
    when_to_use: [
      'You are starting work, or returning after long-running tests/builds.',
      'MCP tools seem missing, or you suspect the MCP server session is stale.',
      'You want to know whether finalize or the commit guard can proceed before acting.',
    ],
    mcp_tools: [
      { name: 'vibecode_session_bootstrap', reason: 'One-call preflight: the runtime_awareness section reports lifecycle (active/stale/terminated), heartbeat age, shared-tree dirty ownership, finalize vs isolated-commit readiness, and exact next commands.' },
      { name: 'vibecode_workspace_info', reason: 'Live server identity (tool_count/version/started_at) — compare against the current build to detect a stale MCP server session.' },
      { name: 'vibecode_agent_heartbeat', reason: 'Heartbeat during long-running work so your session does not go stale.' },
      { name: 'vibecode_git_changes', reason: 'Claim-aware dirty-tree summary: which changed files are yours, another agent’s, or unclaimed.' },
      { name: 'vibecode_finalize_check', reason: 'Conservative commit-readiness gate; the commit guard itself is CLI-only.' },
    ],
    cli_commands: [
      { command: 'vibecode session bootstrap --agent <agent_id> --json', reason: 'Refresh your heartbeat and read the runtime_awareness preflight in one call.' },
      { command: 'vibecode agents heartbeat --agent <agent_id> --json', reason: 'Heartbeat between long test runs without a full re-bootstrap.' },
      { command: 'vibecode mcp tools --json', reason: 'Canonical tool list of the CURRENT build — compare with the live server tool_count to detect a stale MCP server.' },
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for the claim-aware dirty-tree summary.' },
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for the finalize gate.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview whether the guard would commit (possibly isolated) without staging or committing anything.' },
    ],
    next_steps: [
      'If the live server tool_count differs from the current build (`vibecode mcp tools`), restart/reconnect the MCP server or use the CLI fallback.',
      'If your agent is stale, heartbeat or re-run session bootstrap with your agent id; if terminated, register a new agent.',
      'If finalize is blocked only by unrelated unclaimed dirty files, the commit guard may still make an isolated commit of your claimed files.',
    ],
    warnings: [
      'Preflight is read-only: it never releases, reaps, resolves, cleans up, or commits on your behalf.',
      'read_only agents must not edit, claim, finalize, or commit.',
      'Staged unclaimed files hard-block the commit guard — unstage and review them yourself; never commit them.',
      'Use the CLI fallback when the MCP server is stale or missing tools.',
    ],
  },
  session_recovery: {
    profile_id: 'session_recovery',
    title: 'Session recovery / resume',
    purpose: 'Safely resume after an interruption, stale heartbeat, MCP restart, crash, or a partially completed workflow.',
    when_to_use: [
      'You are resuming after an interruption, model crash, long test run, or MCP server restart.',
      'You are unsure whether your agent, claims, or intents are still valid.',
      'session_bootstrap reports a stale or terminated agent, or a recovery state you did not expect.',
    ],
    mcp_tools: [
      { name: 'vibecode_session_bootstrap', reason: 'Start every resume here: runtime_awareness.recovery classifies your resume state and lists the exact safe next commands.' },
      { name: 'vibecode_agent_heartbeat', reason: 'Heartbeat a STALE (never a terminated) agent before continuing; then re-run session bootstrap.' },
      { name: 'vibecode_git_changes', reason: 'Re-inspect the claim-aware dirty state before touching anything you left behind.' },
      { name: 'vibecode_finalize_check', reason: 'Check commit readiness for dirty claimed work from before the interruption.' },
      { name: 'vibecode_claim_intents_list', reason: 'See which of your work intents are still active and whether they are releasable.' },
      { name: 'vibecode_claim_intent_release', reason: 'Release YOUR OWN completed clean intent (dry-run first; same-agent only).' },
      { name: 'vibecode_conflicts_list', reason: 'Inspect conflicts that may still block your previous scope.' },
      { name: 'vibecode_workspace_info', reason: 'Live MCP server identity — detect a stale server session after a restart.' },
    ],
    cli_commands: [
      { command: 'vibecode session bootstrap --agent <agent_id> --json', reason: 'Heartbeat + full re-orientation including the recovery resume state in one call.' },
      { command: 'vibecode agents heartbeat --agent <agent_id> --json', reason: 'Revive a stale agent before resuming work.' },
      { command: 'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json', reason: 'Register a NEW agent when yours is terminated or missing — never reuse the old one.' },
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for the claim-aware dirty-state check.' },
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for the conservative commit-readiness gate.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview committing the dirty claimed work you left behind (inspect skipped-file warnings).' },
      { command: 'vibecode claims intents list --agent <agent_id> --status active --json', reason: 'See your own active intents and their claim counts.' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json', reason: 'Preview releasing one of your OWN clean intents.' },
      { command: 'vibecode mcp tools --json', reason: 'Current build tool list — compare with the live server tool_count to detect a stale MCP server.' },
    ],
    next_steps: [
      'Start with session bootstrap and read runtime_awareness.recovery before anything else.',
      'Stale agent: heartbeat first, then re-run session bootstrap. Terminated or missing agent: register a NEW agent.',
      'Dirty claimed files: git changes → finalize check → commit guard dry-run; inspect skipped-file warnings before an isolated commit.',
      'Own clean intent: dry-run the intent release first, then release it.',
      'Conflicts: switch to conflict_resolution. Stale coordination: switch to coordination_housekeeping.',
      'If expected MCP tools are missing or stale, use the CLI fallback and restart/reconnect the MCP server.',
    ],
    warnings: [
      'Never reuse released claims and never edit without an active claim — re-plan and re-claim instead.',
      'Never heartbeat or resume a terminated agent; register a new one.',
      'Never hand-edit .vibecode coordination state — use the commands above.',
      'No force cleanup, no automatic release/reap/resolve, no ownership transfer, and never release another agent’s intent — recovery is explicit, never automatic.',
      'read_only agents observe only: no claim, edit, finalize, or commit during recovery either.',
    ],
  },
  team_handoff: {
    profile_id: 'team_handoff',
    title: 'Team handoff / cross-agent transition',
    purpose: 'Prepare a read-only handoff packet when one agent stops, and consume it as next-agent onboarding guidance when another agent (or a human) decides who continues.',
    when_to_use: [
      'You are ending a session while active claims, intents, or dirty claimed files still exist.',
      'A human or another agent needs to know whether it is safe to continue this work.',
      'You are the NEXT agent consuming a handoff packet before starting.',
    ],
    mcp_tools: [
      { name: 'vibecode_handoff_prepare', reason: 'PRODUCER: build the read-only handoff packet BEFORE ending — one handoff_state, what must happen before another agent continues, exact safe commands, and do_not_do boundaries.' },
      { name: 'vibecode_handoff_guide', reason: 'CONSUMER: the NEXT agent runs handoff guide BEFORE continuing — one onboarding_state, blocked paths still claimed by the previous agent, and per-agent safe commands. If the previous agent is not ready, do not proceed on its paths.' },
      { name: 'vibecode_session_bootstrap', reason: 'The NEXT agent registers separately here (register=true) — there is no ownership transfer, ever.' },
      { name: 'vibecode_git_changes', reason: 'Inspect claim-aware shared-tree state before handing off or continuing.' },
      { name: 'vibecode_finalize_check', reason: 'Check commit readiness for dirty claimed files before handoff.' },
      { name: 'vibecode_claim_intents_list', reason: 'See which of your own intents are still active before releasing.' },
      { name: 'vibecode_claim_intent_release', reason: 'Release YOUR OWN clean intent before the next agent claims those files (dry-run first; same-agent only).' },
    ],
    cli_commands: [
      { command: 'vibecode handoff prepare --agent <agent_id> --json', reason: 'Run handoff prepare BEFORE ending a session with active work; re-run it after each prerequisite step.' },
      { command: 'vibecode handoff guide --from-agent <from_agent_id> --for-agent <for_agent_id> --json', reason: 'The NEXT agent runs handoff guide BEFORE continuing (omit --for-agent if not registered yet); it must still register and claim exact files itself.' },
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for the claim-aware shared-tree check.' },
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for the commit-readiness gate.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'If dirty claimed files exist: preview the guarded commit (commit or revert before handoff).' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json', reason: 'If a clean own intent exists: preview the release before the next agent may edit those files.' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --json', reason: 'Release your own clean intent after reviewing the dry-run.' },
      { command: 'vibecode session bootstrap --register --agent-mode build --task "<task>" --json', reason: 'The NEXT agent registers itself and claims exact files independently — never reuses the previous agent’s claims.' },
      { command: 'vibecode tools profile --profile build_pre_edit --json', reason: 'The NEXT agent follows the normal pre-edit claim workflow after registering.' },
    ],
    next_steps: [
      'Current agent: commit or revert dirty claimed files (commit guard dry-run first), then release your own clean intents, then re-run handoff prepare until handoff_ready.',
      'Next agent: run handoff guide before continuing — if it reports the previous agent is not ready, do not proceed on its paths; wait for the prerequisites instead.',
      'Next agent: register separately, read the guide’s do_not_do list, then plan and claim the exact files you need after the previous agent released them.',
      'Resuming the SAME agent is not a handoff — use session_recovery instead.',
      'Start any new session with runtime_preflight; if the packet or guide reports a blocking conflict, switch to conflict_resolution; for stale coordination use coordination_housekeeping.',
    ],
    warnings: [
      'Handoff is visibility only: no ownership transfer, no handoff execution, no auto-release, no auto-claim — Vibecode never assigns the next agent.',
      'Never release another agent’s intent — intent release is same-agent only.',
      'Never bypass the commit guard with raw git add/commit, and never hand-edit .vibecode coordination state.',
      'Skipped or unclaimed dirty files in the packet are not safe — inspect them; handoff does not transfer or clean them.',
      'Released claims authorize nothing: the next agent must register and claim explicit files itself.',
    ],
  },
});

/** Narrow an arbitrary value to a known profile id. */
export function isToolProfileId(value: unknown): value is ToolProfileId {
  return typeof value === 'string' && (TOOL_PROFILE_IDS as readonly string[]).includes(value);
}

/** Return all profiles in canonical order (full detail). */
export function listToolProfiles(): ToolProfile[] {
  return TOOL_PROFILE_IDS.map((id) => PROFILES[id]);
}

/** Return a compact one-line summary of every profile in canonical order. */
export function listToolProfileSummaries(): ToolProfileSummary[] {
  return TOOL_PROFILE_IDS.map((id) => {
    const p = PROFILES[id];
    return { profile_id: p.profile_id, title: p.title, purpose: p.purpose };
  });
}

/** Return one profile by id, or null when the id is unknown. */
export function getToolProfile(id: string): ToolProfile | null {
  return isToolProfileId(id) ? PROFILES[id] : null;
}

/** Sorted list of every MCP tool name referenced by any profile (for tests/validation). */
export function toolProfileMcpToolNames(): string[] {
  const names = new Set<string>();
  for (const id of TOOL_PROFILE_IDS) {
    for (const tool of PROFILES[id].mcp_tools) names.add(tool.name);
  }
  return [...names].sort();
}

/** Context the bootstrap aggregator passes to choose recommended profiles. */
export interface BootstrapProfileContext {
  /** Whether the current agent is a registered, valid session. */
  registered: boolean;
  /** Operating mode of the current agent (null when not registered/unknown). */
  operatingMode: 'read_only' | 'build' | null;
  /** Whether the agent has files it claimed that are dirty in the working tree. */
  hasClaimedDirtyFiles: boolean;
  /** Whether the current run has scan artifacts available. */
  scanAvailable: boolean;
  /** Whether the current run has any readable artifacts. */
  artifactsAvailable: boolean;
  /** Whether there are unresolved conflicts or possibly-stale active claims. */
  hasConflictsOrStaleClaims: boolean;
  /**
   * Phase 2C: whether stale coordination state exists (stale agents/claims or
   * active intents with stale/terminated/missing owners or no active claims).
   */
  hasStaleCoordination: boolean;
}

/**
 * Choose a small, deterministic set of recommended profile ids for the current
 * bootstrap context. Returns ids + short reasons (NOT full profiles) so the
 * bootstrap response stays compact. Order: primary workflow profile first, then
 * situational add-ons. Never returns duplicates.
 */
export function recommendBootstrapToolProfiles(
  ctx: BootstrapProfileContext,
): ToolProfileRecommendation[] {
  const out: ToolProfileRecommendation[] = [];
  const push = (profile_id: ToolProfileId, reason: string): void => {
    if (!out.some((r) => r.profile_id === profile_id)) out.push({ profile_id, reason });
  };

  // Primary workflow profile, driven by operating mode + edit state.
  if (!ctx.registered || ctx.operatingMode === null) {
    push('read_only_orientation', 'Not registered yet — orient read-only, then register before editing.');
  } else if (ctx.operatingMode === 'read_only') {
    push('read_only_orientation', 'Read-only agent: inspect the repo without editing.');
  } else {
    // build agent
    if (ctx.hasClaimedDirtyFiles) {
      push('build_post_edit', 'Build agent has claimed files dirty in the working tree.');
      push('safe_commit', 'Validate and commit your claimed files through the guard.');
    } else {
      push('build_pre_edit', 'Build agent has no claimed dirty files yet.');
    }
  }

  // Situational add-ons.
  if (ctx.scanAvailable) {
    push('scan_inspection', 'Scan artifacts are available for the current run.');
  }
  if (ctx.artifactsAvailable) {
    push('artifact_continuation', 'Run artifacts are available; read large ones with continuation.');
  }
  if (ctx.hasConflictsOrStaleClaims) {
    push('conflict_resolution', 'Unresolved conflicts or possibly-stale claims are present.');
  }
  if (ctx.hasStaleCoordination) {
    push('coordination_housekeeping', 'Stale coordination state (stale agents/claims/intents) is present.');
  }

  return out;
}
