/**
 * Deterministic agent guidance profiles for VibecodeMCP Tool Contract v1.
 *
 * The profile API remains available for CLI/operator guidance, but the MCP tool
 * that previously exposed profiles is no longer public. Every MCP tool named
 * here must be one of the 14 v1 public tools.
 */

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
  'team_status',
] as const;

export type ToolProfileId = (typeof TOOL_PROFILE_IDS)[number];

export interface ToolProfileMcpTool {
  name: string;
  reason: string;
}

export interface ToolProfileCliCommand {
  command: string;
  reason: string;
}

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

export interface ToolProfileSummary {
  profile_id: ToolProfileId;
  title: string;
  purpose: string;
}

export interface ToolProfileRecommendation {
  profile_id: ToolProfileId;
  reason: string;
}

const CORE_READ_TOOLS: ToolProfileMcpTool[] = [
  { name: 'vibecode_session_start', reason: 'Start or resume an attributed session.' },
  { name: 'vibecode_workspace_snapshot', reason: 'Read the bounded repo/git/run/claims/CodeGraph snapshot.' },
  { name: 'vibecode_project_instructions', reason: 'Read repo operating rules before changing behavior.' },
  { name: 'vibecode_changes', reason: 'Classify dirty files against claims.' },
];

const CODEGRAPH_TOOLS: ToolProfileMcpTool[] = [
  { name: 'vibecode_codegraph_search', reason: 'Find indexed symbols and files.' },
  { name: 'vibecode_codegraph_explore', reason: 'Explore a subsystem or flow.' },
  { name: 'vibecode_codegraph_callers', reason: 'Check callers before changing a symbol.' },
  { name: 'vibecode_codegraph_impact', reason: 'Estimate blast radius for shared code.' },
];

const BUILD_TOOLS: ToolProfileMcpTool[] = [
  { name: 'vibecode_build_start', reason: 'Claim exact paths as a build intent before editing.' },
  { name: 'vibecode_build_scope', reason: 'Add exact paths or release clean owned paths under the same intent.' },
  { name: 'vibecode_build_finish', reason: 'Run the final claim-aware safety gate and get commit guard guidance.' },
];

function profile(
  profile_id: ToolProfileId,
  title: string,
  purpose: string,
  mcp_tools: ToolProfileMcpTool[],
  cli_commands: ToolProfileCliCommand[],
  extra?: Partial<Pick<ToolProfile, 'when_to_use' | 'next_steps' | 'warnings'>>,
): ToolProfile {
  return {
    profile_id,
    title,
    purpose,
    when_to_use: extra?.when_to_use ?? [purpose],
    mcp_tools,
    cli_commands,
    next_steps: extra?.next_steps ?? ['Follow the v1 workflow: session_start, snapshot, claim exact paths for build work, finish before commit.'],
    warnings: extra?.warnings ?? ['Use only v1 public MCP tools; old MCP names are not callable.'],
  };
}

const COMMON_CLI: ToolProfileCliCommand[] = [
  { command: 'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json', reason: 'CLI fallback to start and orient a session.' },
  { command: 'vibecode git changes --agent <agent_id> --json', reason: 'CLI fallback for claim-aware changes.' },
];

const PROFILES: Readonly<Record<ToolProfileId, ToolProfile>> = Object.freeze({
  read_only_orientation: profile(
    'read_only_orientation',
    'Read-only orientation',
    'Inspect and understand the repo without editing anything.',
    [...CORE_READ_TOOLS, ...CODEGRAPH_TOOLS, { name: 'vibecode_run_status', reason: 'Inspect run status and artifact availability.' }, { name: 'vibecode_artifact_read', reason: 'Read allowlisted run or scan artifacts.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode scan summary --run current --sections "files,commands,tests,symbols" --json', reason: 'CLI fallback for scan orientation.' },
      { command: 'vibecode runs artifact-read --run current --artifact <artifact> --json', reason: 'CLI fallback for run artifacts.' },
    ],
    { warnings: ['read_only agents must not edit files or claim paths.'] },
  ),
  build_pre_edit: profile(
    'build_pre_edit',
    'Build agent before editing',
    'Orient and claim exact files before modifying anything.',
    [...CORE_READ_TOOLS, ...CODEGRAPH_TOOLS, { name: 'vibecode_build_start', reason: 'Required gate before source edits.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode claims add-bulk --agent <agent_id> --intent "<intent>" --path <path> --json', reason: 'CLI fallback for claiming exact paths.' },
    ],
    {
      next_steps: ['Research first, then declare explicit file paths; after edits, run build_finish.'],
      warnings: ['Claim every edited file first. Lockfile changes such as package-lock.json must be claimed if intentional or reverted if accidental.'],
    },
  ),
  build_post_edit: profile(
    'build_post_edit',
    'Build agent after editing',
    'Validate claimed changes and prepare a safe scoped commit.',
    [...CORE_READ_TOOLS, ...BUILD_TOOLS],
    [
      ...COMMON_CLI,
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for the final safety gate.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview the scoped commit.' },
    ],
    {
      next_steps: ['If unclaimed files appear, claim them explicitly if intentional or revert them. Commit guard can skip unrelated unclaimed dirty files; skipped files stay dirty.'],
      warnings: ['Commit through commit guard. Do not bypass it with raw git add/commit unless a human explicitly directs it.'],
    },
  ),
  scan_inspection: profile(
    'scan_inspection',
    'Scan artifact inspection',
    'Use deterministic scan intelligence to orient on the repo.',
    [...CORE_READ_TOOLS, { name: 'vibecode_run_status', reason: 'Check scan artifact availability.' }, { name: 'vibecode_artifact_read', reason: 'Read scan artifacts through artifact_type=scan.' }],
    [
      { command: 'vibecode scan summary --run current --sections "files,commands,tests,symbols" --json', reason: 'CLI fallback for a focused scan summary.' },
      { command: 'vibecode scan artifact-read --run current --artifact <artifact> --json', reason: 'CLI fallback for a scan artifact.' },
    ],
  ),
  artifact_continuation: profile(
    'artifact_continuation',
    'Large artifact continuation',
    'Read large run or scan artifacts without partial-context traps.',
    [{ name: 'vibecode_run_status', reason: 'Find available artifacts.' }, { name: 'vibecode_artifact_read', reason: 'Read chunks and continue from next_cursor.' }],
    [
      { command: 'vibecode runs artifact-read --run current --artifact <artifact> --max-bytes 16000 --json', reason: 'CLI fallback for run artifact paging.' },
      { command: 'vibecode scan artifact-read --run current --artifact <artifact> --max-bytes 16000 --json', reason: 'CLI fallback for scan artifact paging.' },
    ],
  ),
  safe_commit: profile(
    'safe_commit',
    'Safe scoped commit',
    'Commit only claimed files through the CLI guard.',
    [...CORE_READ_TOOLS, { name: 'vibecode_build_finish', reason: 'Return readiness and exact commit guard command.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview staging only claimed files.' },
      { command: 'vibecode commit guard --agent <agent_id> --message "<message>" --json', reason: 'Commit only claimed files through the guard.' },
    ],
    {
      next_steps: ['Use build_finish, dry-run commit guard, then commit guard. Unclaimed files may be skipped and stay dirty.'],
      warnings: ['Staged unclaimed files require you to unstage and review them. Do not bypass the guard. Claim or revert intentional lockfile changes before commit.'],
    },
  ),
  conflict_resolution: profile(
    'conflict_resolution',
    'Claim conflict resolution',
    'Inspect blockers and choose a safe next step.',
    [...CORE_READ_TOOLS, { name: 'vibecode_build_start', reason: 'Reports claim denials for exact paths.' }, { name: 'vibecode_handoff', reason: 'Use prepare/guide for visibility when another agent owns work.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode conflicts list --json', reason: 'CLI fallback for conflict history.' },
      { command: 'vibecode claims list --json', reason: 'CLI fallback for active claims.' },
    ],
    { warnings: ['Do not edit another agent claimed path. Do not force cleanup or hand-edit .vibecode state.'] },
  ),
  coordination_housekeeping: profile(
    'coordination_housekeeping',
    'Coordination housekeeping',
    'Inspect stale or conflicting coordination state without automatic cleanup.',
    [...CORE_READ_TOOLS, { name: 'vibecode_build_finish', reason: 'Shows release readiness for owned work.' }, { name: 'vibecode_handoff', reason: 'Prepare handoff visibility.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode agents heartbeat --agent <agent_id> --json', reason: 'CLI fallback heartbeat while old sessions still use heartbeat internally.' },
      { command: 'vibecode claims intents list --agent <agent_id> --json', reason: 'CLI fallback for own intents.' },
      { command: 'vibecode claims list --json', reason: 'CLI fallback for active claims.' },
      { command: 'vibecode claims reap --dry-run --json', reason: 'Preview stale cleanup; do not force it blindly.' },
    ],
    { warnings: ['Never release another agent work. No force or automatic cleanup. Do not edit .vibecode manually. Unclaimed dirty files remain blockers.'] },
  ),
  runtime_preflight: profile(
    'runtime_preflight',
    'Runtime preflight',
    'Verify session, server, and shared-tree state before editing.',
    [...CORE_READ_TOOLS, { name: 'vibecode_build_finish', reason: 'Check finalize/commit readiness when building.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode session bootstrap --agent <agent_id> --json', reason: 'CLI fallback to refresh an existing session.' },
      { command: 'vibecode agents heartbeat --agent <agent_id> --json', reason: 'CLI fallback heartbeat for long-running sessions.' },
      { command: 'vibecode mcp tools --json', reason: 'CLI fallback to compare current tool count after restart/reconnect.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview readiness without committing.' },
    ],
    { warnings: ['Read-only preflight does not release, reap, resolve, or commit. Use CLI fallback if MCP is stale; restart or reconnect if tool_count differs.'] },
  ),
  session_recovery: profile(
    'session_recovery',
    'Session recovery / resume',
    'Safely resume after interruption or MCP restart.',
    [...CORE_READ_TOOLS, ...BUILD_TOOLS],
    [
      ...COMMON_CLI,
      { command: 'vibecode session bootstrap --agent <agent_id> --json', reason: 'CLI fallback to resume and inspect an existing session.' },
      { command: 'vibecode agents heartbeat --agent <agent_id> --json', reason: 'CLI fallback heartbeat before resuming stale sessions.' },
      { command: 'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json', reason: 'Register a new agent if the old one is terminated or missing.' },
      { command: 'vibecode finalize check --agent <agent_id> --json', reason: 'CLI fallback for finalizing recovered claimed work.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview committing dirty claimed work.' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json', reason: 'Preview releasing your own clean intent.' },
      { command: 'vibecode mcp tools --json', reason: 'CLI fallback after restart/reconnect.' },
    ],
    { warnings: ['Do not reuse released claims. Do not resume a terminated agent; register a new agent. No ownership transfer, no force cleanup, no .vibecode hand edits.'] },
  ),
  team_handoff: profile(
    'team_handoff',
    'Team handoff / cross-agent transition',
    'Prepare or consume handoff guidance without transferring ownership.',
    [...CORE_READ_TOOLS, { name: 'vibecode_handoff', reason: 'Use mode=prepare or mode=guide; ownership never transfers.' }, { name: 'vibecode_build_start', reason: 'Next agent must claim exact files itself.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode handoff prepare --agent <agent_id> --json', reason: 'CLI fallback for producer handoff.' },
      { command: 'vibecode handoff guide --from-agent <from_agent_id> --for-agent <for_agent_id> --json', reason: 'CLI fallback handoff guide for a different next agent before continuing; same-agent continuation belongs to session_recovery; if previous agent is not ready, do not proceed.' },
      { command: 'vibecode commit guard --agent <agent_id> --dry-run --json', reason: 'Preview commit or revert before handoff.' },
      { command: 'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json', reason: 'Preview releasing your own clean active claims by intent.' },
      { command: 'vibecode claims release --claim <claim_id> --json', reason: 'Release your own clean claim only when safe.' },
      { command: 'vibecode session bootstrap --register --agent-mode build --task "<task>" --json', reason: 'Next agent registers separately before claiming work.' },
    ],
    { warnings: ['No ownership transfer. Never release another agent intent. Next agent must register and claim explicitly. Do not hand-edit .vibecode state. Active claims must be released safely. Use session_recovery for same-agent continuation, runtime_preflight before resuming a shared tree, and conflict_resolution when another agent blocks a path.'] },
  ),
  team_status: profile(
    'team_status',
    'Team status / team overview',
    'Read a point-in-time overview before deciding who continues.',
    [...CORE_READ_TOOLS, { name: 'vibecode_handoff', reason: 'Prepare or consume handoff visibility.' }],
    [
      ...COMMON_CLI,
      { command: 'vibecode team status --json', reason: 'CLI fallback for team overview.' },
      { command: 'vibecode claims list --json', reason: 'CLI fallback for active claims.' },
    ],
    { warnings: ['Observability only. No assignment, auto-claim, auto-release, auto-reap, or ownership transfer.'] },
  ),
});

export function isToolProfileId(value: unknown): value is ToolProfileId {
  return typeof value === 'string' && (TOOL_PROFILE_IDS as readonly string[]).includes(value);
}

export function listToolProfiles(): ToolProfile[] {
  return TOOL_PROFILE_IDS.map((id) => PROFILES[id]);
}

export function listToolProfileSummaries(): ToolProfileSummary[] {
  return TOOL_PROFILE_IDS.map((id) => {
    const p = PROFILES[id];
    return { profile_id: p.profile_id, title: p.title, purpose: p.purpose };
  });
}

export function getToolProfile(id: string): ToolProfile | null {
  return isToolProfileId(id) ? PROFILES[id] : null;
}

export function toolProfileMcpToolNames(): string[] {
  const names = new Set<string>();
  for (const id of TOOL_PROFILE_IDS) {
    for (const tool of PROFILES[id].mcp_tools) names.add(tool.name);
  }
  return [...names].sort();
}

export interface BootstrapProfileContext {
  registered: boolean;
  operatingMode: 'read_only' | 'build' | null;
  hasClaimedDirtyFiles: boolean;
  scanAvailable: boolean;
  artifactsAvailable: boolean;
  hasConflictsOrStaleClaims: boolean;
  hasStaleCoordination: boolean;
}

export function recommendBootstrapToolProfiles(
  ctx: BootstrapProfileContext,
): ToolProfileRecommendation[] {
  const out: ToolProfileRecommendation[] = [];
  const push = (profile_id: ToolProfileId, reason: string): void => {
    if (!out.some((r) => r.profile_id === profile_id)) out.push({ profile_id, reason });
  };

  if (!ctx.registered || ctx.operatingMode === null || ctx.operatingMode === 'read_only') {
    push('read_only_orientation', 'Orient read-only before editing.');
  } else if (ctx.hasClaimedDirtyFiles) {
    push('build_post_edit', 'Build agent has claimed dirty files.');
    push('safe_commit', 'Validate and commit claimed files through the guard.');
  } else {
    push('build_pre_edit', 'Build agent has no claimed dirty files yet.');
  }

  if (ctx.scanAvailable) push('scan_inspection', 'Scan artifacts are available.');
  if (ctx.artifactsAvailable) push('artifact_continuation', 'Run artifacts are available.');
  if (ctx.hasConflictsOrStaleClaims) push('conflict_resolution', 'Conflicts or stale claims are present.');
  if (ctx.hasStaleCoordination) push('coordination_housekeeping', 'Stale coordination state is present.');
  return out;
}
