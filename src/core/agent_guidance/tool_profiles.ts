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
      'When finalize is ok, use safe_commit (commit guard is CLI-only).',
    ],
    warnings: [
      'Commit through `vibecode commit guard` — never raw git add/commit.',
      'Commit guard is intentionally CLI-only; there is no MCP commit tool.',
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
    ],
    cli_commands: [
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for the final dirty-state check.' },
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for the finalize gate.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview the scoped commit (no staging/commit).' },
      { command: 'vibecode commit guard --agent <agent_id> --message "<message>" --json', reason: 'Commit ONLY your claimed files through the guard.' },
    ],
    next_steps: [
      'After a successful guarded commit, release claims or terminate the session when done.',
    ],
    warnings: [
      'Commit mutation is CLI-only by design; there is no MCP commit tool.',
      'The guard never stages broad paths and leaves other agents’ files untouched.',
      'A lockfile (e.g. package-lock.json) changed by an install can block finalize. Claim it if the change is intentional, or revert it if it is accidental, before committing.',
    ],
  },
  conflict_resolution: {
    profile_id: 'conflict_resolution',
    title: 'Claim conflict resolution',
    purpose: 'Inspect and resolve overlapping claims or recorded conflicts.',
    when_to_use: [
      'A claim was denied, or there are unresolved conflicts / possibly-stale claims.',
      'Two agents are competing for the same file.',
    ],
    mcp_tools: [
      { name: 'vibecode_claims_list', reason: 'See all claims with stale-aware status to find the overlap.' },
      { name: 'vibecode_conflicts_list', reason: 'List recorded coordination conflicts (claim_denied, stale_claim).' },
      { name: 'vibecode_conflict_resolve', reason: 'Mark a coordination conflict resolved once handled.' },
      { name: 'vibecode_session_bootstrap', reason: 'Re-orient on active agents/claims/conflicts before acting.' },
      { name: 'vibecode_git_changes', reason: 'Check whether the contested files are actually dirty.' },
    ],
    cli_commands: [
      { command: 'vibecode claims list --json', reason: 'CLI fallback to inspect overlapping claims.' },
      { command: 'vibecode conflicts list --json', reason: 'CLI fallback to inspect recorded conflicts.' },
      { command: 'vibecode session bootstrap --agent <agent_id> --json', reason: 'Re-orient (heartbeat) and see the current conflict state.' },
      { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback to check whether contested files are dirty.' },
    ],
    next_steps: [
      'Wait for the owner to release, retry as a shared claim when compatible, or coordinate a handoff.',
    ],
    warnings: [
      'Do not edit a file whose claim was denied; coordination is advisory but overlapping edits cause lost work.',
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

  return out;
}
