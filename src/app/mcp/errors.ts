/**
 * Stable error codes returned by VibecodeMCP tools.
 *
 * Each tool maps its internal failure to one of these codes so that MCP
 * clients (Claude Code, Codex, OpenCode, Hermes, anything that speaks the
 * Model Context Protocol) get a consistent error envelope across the whole
 * VibecodeMCP surface — independent of provider, transport, or repo layout.
 *
 * The error codes are kept in lock-step with the CLI's structured error
 * codes for parity:
 *   - REPO_NOT_FOUND / REPO_NOT_A_DIRECTORY    (resolveRepoRoot)
 *   - CODEGRAPH_NOT_INSTALLED                  (codegraph query commands)
 *   - CODEGRAPH_NOT_INITIALIZED                (codegraph query commands)
 *   - CODEGRAPH_QUERY_FAILED                   (codegraph query commands)
 *   - INVALID_ARGUMENT                         (tool input validation)
 *   - MCP_TOOL_TIMEOUT                         (per-tool timeout)
 *   - OUTPUT_TRUNCATED                         (bounded output marker)
 *   - UNSUPPORTED_TOOL                         (tools/call unknown name)
 */
export type McpErrorCode =
  | 'REPO_NOT_FOUND'
  | 'REPO_NOT_A_DIRECTORY'
  | 'CODEGRAPH_NOT_INSTALLED'
  | 'CODEGRAPH_NOT_INITIALIZED'
  | 'CODEGRAPH_QUERY_FAILED'
  | 'INVALID_ARGUMENT'
  | 'MCP_TOOL_TIMEOUT'
  | 'OUTPUT_TRUNCATED'
  | 'UNSUPPORTED_TOOL'
  // Phase MCP-2: run / artifact tools.
  | 'RUN_NOT_FOUND'
  | 'RUN_MANIFEST_INVALID'
  | 'ARTIFACT_NOT_ALLOWED'
  | 'ARTIFACT_NOT_FOUND'
  | 'VIBECODE_ARTIFACT_READ_FAILED'
  // Phase MCP-3: read-only workspace orientation tools.
  | 'WORKSPACE_INFO_FAILED'
  | 'WORKSPACE_STATUS_FAILED'
  | 'PROJECT_INSTRUCTIONS_NOT_FOUND'
  | 'PROJECT_INSTRUCTIONS_READ_FAILED'
  // Phase Coordination-1: read-only coordination status tool.
  | 'COORDINATION_STATUS_FAILED'
  // Phase Coordination-2: agent session tools.
  | 'AGENT_NOT_FOUND'
  | 'AGENT_REGISTER_FAILED'
  | 'AGENT_HEARTBEAT_FAILED'
  | 'AGENTS_LIST_FAILED'
  | 'AGENT_STATUS_FAILED'
  // Phase Coordination-3A: advisory file claim tools.
  | 'AGENT_NOT_ACTIVE'
  | 'CLAIM_DENIED'
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_ADD_FAILED'
  | 'CLAIMS_LIST_FAILED'
  | 'CLAIM_STATUS_FAILED'
  | 'CLAIM_RELEASE_FAILED'
  // Phase 2A: agent-declared work scope — claim plan + explicit bulk claim.
  | 'CLAIMS_PLAN_FAILED'
  | 'CLAIMS_ADD_BULK_FAILED'
  | 'NO_CLAIM_PATHS'
  | 'INVALID_INTENT'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_FORBIDDEN'
  // Phase 2B: claim intent lifecycle / release-by-intent. Blocked releases
  // (dirty files, git unavailable) are ok-envelope results, not error codes —
  // consistent with the Phase 2A blocked bulk-claim semantics.
  | 'CLAIM_INTENTS_LIST_FAILED'
  | 'CLAIM_INTENT_RELEASE_FAILED'
  // Phase Coordination-4A: read-only finalize check.
  | 'FINALIZE_CHECK_FAILED'
  // Phase Coordination-4C: watcher evidence tools.
  | 'EVIDENCE_LIST_FAILED'
  | 'EVIDENCE_SCAN_FAILED'
  // Phase Coordination-4D-cleanup: claims reap + conflict tools.
  | 'CLAIMS_REAP_FAILED'
  | 'CONFLICTS_LIST_FAILED'
  | 'CONFLICT_RESOLVE_FAILED'
  // Phase 2D: conflict triage detail.
  | 'CONFLICT_DETAIL_FAILED'
  // Phase 1A: session bootstrap + claim-aware git changes.
  | 'AGENT_TERMINATED'
  | 'SESSION_BOOTSTRAP_FAILED'
  | 'GIT_CHANGES_FAILED'
  | 'READ_ONLY_AGENT'
  | 'INVALID_AGENT_SESSION'
  // Phase 1B-2: bounded scan summary + allowlisted scan artifact reads.
  | 'SCAN_SUMMARY_FAILED'
  | 'SCAN_ARTIFACT_READ_FAILED'
  // Phase 1B-3: tool profiles / recommended tool sets.
  | 'TOOL_PROFILE_FAILED'
  // Phase 4A: read-only handoff packet.
  | 'HANDOFF_PREPARE_FAILED'
  // Phase 4B: read-only next-agent onboarding guide.
  | 'HANDOFF_GUIDE_FAILED'
  // Phase 4C: read-only team status / team overview.
  | 'TEAM_STATUS_FAILED';

export interface McpStructuredError {
  code: McpErrorCode;
  message: string;
  /** Whether the client should retry the same call with the same input. */
  retryable: boolean;
  /** Short, actionable next step a human/agent can follow. */
  suggestion?: string;
  /**
   * Optional structured payload passed through from a core service (for example
   * the blocking/conflicting claims on a CLAIM_DENIED). Keeps MCP at parity with
   * the CLI without forcing clients to parse the human message string.
   */
  details?: Record<string, unknown>;
}

const ERROR_DEFAULTS: Record<
  McpErrorCode,
  { retryable: boolean; suggestion: string }
> = {
  REPO_NOT_FOUND: {
    retryable: false,
    suggestion: 'Start the server with --repo <existing-directory>.',
  },
  REPO_NOT_A_DIRECTORY: {
    retryable: false,
    suggestion: 'Point --repo at a directory, not a file.',
  },
  CODEGRAPH_NOT_INSTALLED: {
    retryable: false,
    suggestion:
      'Install upstream CodeGraph, set VIBECODE_CODEGRAPH_BIN, or run `vibecode codegraph binary set <path>`.',
  },
  CODEGRAPH_NOT_INITIALIZED: {
    retryable: false,
    suggestion:
      'Run `vibecode codegraph init --repo <path>` once to initialize the local index.',
  },
  CODEGRAPH_QUERY_FAILED: {
    retryable: true,
    suggestion:
      'Inspect the warnings, verify the upstream codegraph version, and try the call again with a smaller bound.',
  },
  INVALID_ARGUMENT: {
    retryable: false,
    suggestion:
      'Fix the offending tool argument per the tool input schema returned by tools/list.',
  },
  MCP_TOOL_TIMEOUT: {
    retryable: true,
    suggestion: 'Raise the per-call timeout argument and retry.',
  },
  OUTPUT_TRUNCATED: {
    retryable: false,
    suggestion: 'Request a smaller result set or read fewer bytes per call.',
  },
  UNSUPPORTED_TOOL: {
    retryable: false,
    suggestion: 'Call tools/list to discover the tools this server exposes.',
  },
  RUN_NOT_FOUND: {
    retryable: false,
    suggestion:
      'Call vibecode_run_status to inspect the current/latest run, or use the "latest"/"current" alias.',
  },
  RUN_MANIFEST_INVALID: {
    retryable: false,
    suggestion:
      'The .vibecode/current/run_manifest.json pointer or the run’s own run_manifest.json is malformed. Re-run the pipeline or restore the manifest.',
  },
  ARTIFACT_NOT_ALLOWED: {
    retryable: false,
    suggestion:
      'Pass an allowlisted artifact name (for example final_prompt, context_pack, flash_output, codegraph). The full allowlist is returned in error.details.',
  },
  ARTIFACT_NOT_FOUND: {
    retryable: false,
    suggestion:
      'The artifact name is allowlisted but the file does not exist for this run yet. Inspect vibecode_run_status to see which artifacts the run produced.',
  },
  VIBECODE_ARTIFACT_READ_FAILED: {
    retryable: true,
    suggestion:
      'Verify the run directory has not been modified or removed, then retry. If the run is partial, look at vibecode_run_status first.',
  },
  WORKSPACE_INFO_FAILED: {
    retryable: true,
    suggestion:
      'Inspect the warnings — workspace_info reports a CodeGraph-status warning rather than failing the call. Retry only if the failure is transient.',
  },
  WORKSPACE_STATUS_FAILED: {
    retryable: true,
    suggestion:
      'Inspect the warnings — workspace_status reports non-git repos as warnings rather than errors. Retry only if the failure is transient.',
  },
  PROJECT_INSTRUCTIONS_NOT_FOUND: {
    retryable: false,
    suggestion:
      'No allowlisted project instructions (AGENTS.md / CONTRIBUTING.md / README.md / docs/codegraph.md) and no current-run scan/repo_instructions.json artifact were found.',
  },
  PROJECT_INSTRUCTIONS_READ_FAILED: {
    retryable: true,
    suggestion:
      'Inspect the warning detail; the scan artifact or fallback file may have been deleted or replaced mid-call.',
  },
  COORDINATION_STATUS_FAILED: {
    retryable: true,
    suggestion:
      'Coordination status is read-only and degrades to an empty state on a missing file. Retry only if the failure is transient (e.g. a filesystem error).',
  },
  AGENT_NOT_FOUND: {
    retryable: false,
    suggestion:
      'Start a session with vibecode_session_start (omit agent_id to register a new agent, or pass an existing agent_id to resume).',
  },
  AGENT_REGISTER_FAILED: {
    retryable: true,
    suggestion:
      'Verify the name and type arguments, then retry. type must be one of claude|codex|hermes|opencode|custom.',
  },
  AGENT_HEARTBEAT_FAILED: {
    retryable: true,
    suggestion: 'Verify the agent_id exists and retry if the failure is transient.',
  },
  AGENTS_LIST_FAILED: {
    retryable: true,
    suggestion: 'Listing is read-only and degrades to an empty list on a missing file. Retry only if transient.',
  },
  AGENT_STATUS_FAILED: {
    retryable: true,
    suggestion: 'Verify the agent_id exists and retry if the failure is transient.',
  },
  AGENT_NOT_ACTIVE: {
    retryable: false,
    suggestion: 'Heartbeat or register an active agent before creating a claim.',
  },
  CLAIM_DENIED: {
    retryable: false,
    suggestion: 'Inspect overlapping claims, release an existing claim if appropriate, or retry with a shared claim when compatible.',
  },
  CLAIM_NOT_FOUND: {
    retryable: false,
    suggestion: 'Inspect active claims via vibecode_workspace_snapshot (claims_summary) or the CLI: vibecode claims list --json.',
  },
  CLAIM_ADD_FAILED: {
    retryable: true,
    suggestion: 'Verify agent_id, path, and mode, then retry if the failure is transient.',
  },
  CLAIMS_LIST_FAILED: {
    retryable: true,
    suggestion: 'Listing is read-only and degrades to an empty list on a missing file. Retry only if transient.',
  },
  CLAIM_STATUS_FAILED: {
    retryable: true,
    suggestion: 'Verify the path argument is repository-relative and retry if the failure is transient.',
  },
  CLAIM_RELEASE_FAILED: {
    retryable: true,
    suggestion: 'Verify the claim_id exists and retry if the failure is transient.',
  },
  CLAIMS_PLAN_FAILED: {
    retryable: true,
    suggestion:
      'claims_plan is read-only and evaluates only the explicit paths you supply (no inference). Verify agent_id and paths, then retry if the failure is transient.',
  },
  CLAIMS_ADD_BULK_FAILED: {
    retryable: true,
    suggestion:
      'claims_add_bulk claims the explicit paths atomically. A conflict is returned as ok=true with status="blocked" (no claims created), not as this error. Verify inputs and retry only if the failure is transient.',
  },
  NO_CLAIM_PATHS: {
    retryable: false,
    suggestion:
      'Supply at least one explicit path. Vibecode does not infer which files an agent needs; declare the exact paths yourself.',
  },
  INVALID_INTENT: {
    retryable: false,
    suggestion:
      'Provide a non-empty intent when creating a new work scope, or pass intent_id to extend an existing one.',
  },
  INTENT_NOT_FOUND: {
    retryable: false,
    suggestion:
      'The intent_id does not exist. Start a new build scope with vibecode_build_start (omit intent_id), or check your session via vibecode_session_start.',
  },
  INTENT_FORBIDDEN: {
    retryable: false,
    suggestion:
      'Only the owning agent may extend a work intent. Create your own intent instead of extending another agent\'s.',
  },
  CLAIM_INTENTS_LIST_FAILED: {
    retryable: true,
    suggestion:
      'Listing intents is read-only and degrades to an empty list on a missing file. Verify agent_id, then retry if the failure is transient.',
  },
  CLAIM_INTENT_RELEASE_FAILED: {
    retryable: true,
    suggestion:
      'Verify agent_id and intent_id exist. If blocked by dirty files, commit or revert them first, then retry.',
  },
  FINALIZE_CHECK_FAILED: {
    retryable: true,
    suggestion:
      'Pass agent_id or run_id. The check is read-only; blocked results are returned as ok=true with status="blocked", not as this error. Retry only if the failure is transient.',
  },
  EVIDENCE_LIST_FAILED: {
    retryable: true,
    suggestion:
      'Listing evidence is read-only and degrades to an empty list on a missing log. Retry only if the failure is transient (e.g. a filesystem error).',
  },
  EVIDENCE_SCAN_FAILED: {
    retryable: true,
    suggestion:
      'Scan reads the git working tree and writes only generated evidence state. Verify the bound path is a git repository, then retry if the failure is transient.',
  },
  CLAIMS_REAP_FAILED: {
    retryable: true,
    suggestion:
      'Reap releases claims from stale/terminated agents. Verify coordination state is accessible, then retry if the failure is transient.',
  },
  CONFLICTS_LIST_FAILED: {
    retryable: true,
    suggestion:
      'Listing conflicts is read-only and degrades to an empty list on a missing file. Retry only if transient.',
  },
  CONFLICT_RESOLVE_FAILED: {
    retryable: true,
    suggestion:
      'Verify the conflict_id exists (CLI: vibecode conflicts list --json) and retry if the failure is transient.',
  },
  CONFLICT_DETAIL_FAILED: {
    retryable: true,
    suggestion:
      'Verify the conflict_id exists (CLI: vibecode conflicts list --json) and retry if the failure is transient.',
  },
  AGENT_TERMINATED: {
    retryable: false,
    suggestion:
      'The supplied agent_id is terminated. Register a new agent via vibecode_session_start (mode + task, no agent_id).',
  },
  SESSION_BOOTSTRAP_FAILED: {
    retryable: true,
    suggestion:
      'Bootstrap is read-only by default and registers/heartbeats only when asked. Verify register inputs (agent_mode + task) or the agent_id, then retry.',
  },
  GIT_CHANGES_FAILED: {
    retryable: true,
    suggestion:
      'git_changes reads the working tree read-only. Verify the bound path is a git repository, then retry if the failure is transient.',
  },
  READ_ONLY_AGENT: {
    retryable: false,
    suggestion:
      'The agent is operating in read_only mode. Only build agents may claim files or modify the working tree. Re-register with agent_mode=build if file edits are needed.',
  },
  INVALID_AGENT_SESSION: {
    retryable: false,
    suggestion:
      'The agent session is missing required metadata (operating_mode or task). Re-register through vibecode_session_start with mode and task.',
  },
  SCAN_SUMMARY_FAILED: {
    retryable: true,
    suggestion:
      'scan_summary reads existing scan artifacts read-only and degrades to scan_available=false when none exist. It never runs the scanner. Retry only if the failure is transient (e.g. a filesystem error).',
  },
  SCAN_ARTIFACT_READ_FAILED: {
    retryable: true,
    suggestion:
      'Scan artifact reads return one allowlisted scan artifact in bounded chunks. Verify the artifact key (see vibecode_run_status artifact availability) and cursor/max_bytes, then retry if the failure is transient.',
  },
  TOOL_PROFILE_FAILED: {
    retryable: false,
    suggestion:
      'tool_profile is static and read-only. Omit profile to list profiles, or pass a known profile id (see the list response). This error indicates an unexpected internal failure, not a bad argument.',
  },
  HANDOFF_PREPARE_FAILED: {
    retryable: true,
    suggestion:
      'handoff_prepare is read-only (it never transfers, releases, or claims anything). Terminated/missing agents are reported inside the packet, not as this error. Verify the agent_id and retry only if the failure is transient.',
  },
  HANDOFF_GUIDE_FAILED: {
    retryable: true,
    suggestion:
      'handoff_guide is read-only (it never transfers ownership, registers, releases, or claims anything). Missing previous/next agents are reported inside the guide as safe onboarding states, not as this error. Verify from_agent_id and retry only if the failure is transient.',
  },
  TEAM_STATUS_FAILED: {
    retryable: true,
    suggestion:
      'team_status is read-only and degrades to an empty overview on a missing coordination state. Verify the repo root is correct and retry only if the failure is transient.',
  },
};

/** Build a structured error envelope, attaching the canonical defaults. */
export function buildMcpError(
  code: McpErrorCode,
  message: string,
  overrides: Partial<Pick<McpStructuredError, 'retryable' | 'suggestion' | 'details'>> = {},
): McpStructuredError {
  const defaults = ERROR_DEFAULTS[code];
  const error: McpStructuredError = {
    code,
    message,
    retryable: overrides.retryable ?? defaults.retryable,
    suggestion: overrides.suggestion ?? defaults.suggestion,
  };
  if (overrides.details !== undefined) error.details = overrides.details;
  return error;
}
