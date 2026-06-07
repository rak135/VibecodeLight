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
  // Phase Coordination-4A: read-only finalize check.
  | 'FINALIZE_CHECK_FAILED'
  // Phase Coordination-4C: watcher evidence tools.
  | 'EVIDENCE_LIST_FAILED'
  | 'EVIDENCE_SCAN_FAILED'
  // Phase Coordination-4D-cleanup: claims reap + conflict tools.
  | 'CLAIMS_REAP_FAILED'
  | 'CONFLICTS_LIST_FAILED'
  | 'CONFLICT_RESOLVE_FAILED';

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
      'Call vibecode_runs_list to enumerate available run ids, or use the "latest"/"current" alias.',
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
      'The artifact name is allowlisted but the file does not exist for this run yet. Inspect vibecode_run_get to see which artifacts the run produced.',
  },
  VIBECODE_ARTIFACT_READ_FAILED: {
    retryable: true,
    suggestion:
      'Verify the run directory has not been modified or removed, then retry. If the run is partial, look at vibecode_run_get first.',
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
      'Call vibecode_agents_list to enumerate registered agent ids, or register the agent first with vibecode_agent_register.',
  },
  AGENT_REGISTER_FAILED: {
    retryable: true,
    suggestion:
      'Verify the name and type arguments, then retry. type must be one of claude|codex|hermes|opencode|custom.',
  },
  AGENT_HEARTBEAT_FAILED: {
    retryable: true,
    suggestion: 'Verify the agent_id exists (vibecode_agents_list) and retry if the failure is transient.',
  },
  AGENTS_LIST_FAILED: {
    retryable: true,
    suggestion: 'Listing is read-only and degrades to an empty list on a missing file. Retry only if transient.',
  },
  AGENT_STATUS_FAILED: {
    retryable: true,
    suggestion: 'Verify the agent_id exists (vibecode_agents_list) and retry if the failure is transient.',
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
    suggestion: 'Call vibecode_claims_list to enumerate active claim ids.',
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
      'Verify the conflict_id exists (vibecode_conflicts_list) and retry if the failure is transient.',
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
