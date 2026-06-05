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
  | 'UNSUPPORTED_TOOL';

export interface McpStructuredError {
  code: McpErrorCode;
  message: string;
  /** Whether the client should retry the same call with the same input. */
  retryable: boolean;
  /** Short, actionable next step a human/agent can follow. */
  suggestion?: string;
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
};

/** Build a structured error envelope, attaching the canonical defaults. */
export function buildMcpError(
  code: McpErrorCode,
  message: string,
  overrides: Partial<Pick<McpStructuredError, 'retryable' | 'suggestion'>> = {},
): McpStructuredError {
  const defaults = ERROR_DEFAULTS[code];
  return {
    code,
    message,
    retryable: overrides.retryable ?? defaults.retryable,
    suggestion: overrides.suggestion ?? defaults.suggestion,
  };
}
