/**
 * CodeGraph pipeline transport (Phase 1B).
 *
 * The transport selects how the prompt pipeline queries the existing local
 * CodeGraph index when CodeGraph is set to use-existing mode:
 *
 * - cli  — invoke the existing CodeGraph CLI adapter (`codegraph context …`).
 * - mcp  — invoke the upstream CodeGraph MCP server (`codegraph serve --mcp`)
 *          and call its `codegraph_context` tool. Strict: failure does not
 *          silently fall back to the CLI.
 * - auto — prefer MCP; if MCP fails, emit a warning and fall back to CLI.
 *
 * The transport is independent of the CodeGraph mode (detect-only vs
 * use-existing). In detect-only mode the transport is recorded but never used
 * to query context.
 */
export type CodeGraphTransport = 'cli' | 'mcp' | 'auto';

/** Default transport when no preference is recorded by the GUI/CLI. */
export const DEFAULT_CODEGRAPH_TRANSPORT: CodeGraphTransport = 'cli';

const TRANSPORTS = new Set<CodeGraphTransport>(['cli', 'mcp', 'auto']);

/**
 * Normalize an arbitrary persisted/user input into a valid transport. Unknown
 * or missing values fall through to the default transport. The GUI uses this
 * when reading persisted values; the pipeline uses it when accepting external
 * input (IPC, tests).
 */
export function normalizeCodeGraphTransport(value: unknown): CodeGraphTransport {
  if (typeof value !== 'string') return DEFAULT_CODEGRAPH_TRANSPORT;
  const trimmed = value.trim().toLowerCase();
  return TRANSPORTS.has(trimmed as CodeGraphTransport) ? (trimmed as CodeGraphTransport) : DEFAULT_CODEGRAPH_TRANSPORT;
}

/** Stable identifier used by the desktop renderer and tests for persistence. */
export const CODEGRAPH_TRANSPORT_STORAGE_KEY = 'vibecode.codegraphTransport';
