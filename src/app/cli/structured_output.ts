/**
 * Canonical CLI structured-output helpers.
 *
 * This is the single source of truth for the CLI's structured error envelope.
 * It is presentation/output code for the `vibecode` CLI only — it is NOT
 * business logic and must NOT move into `src/core`. MCP has its own output
 * helpers (`src/app/mcp/format.ts`); do not couple the two.
 *
 * Error envelope (stable):
 *   { ok: false, error: { code, message, path, details } }
 */

export interface CliStructuredError {
  code: string;
  message: string;
  path: string;
  details: string[];
}

/**
 * Build a CLI structured error. `path` defaults to an empty string and
 * `details` to an empty array so the envelope shape is always complete (fields
 * are present-but-empty, never omitted) — matching historical CLI behavior.
 */
export function makeCliStructuredError(
  code: string,
  message: string,
  pathValue = '',
  details: string[] = [],
): CliStructuredError {
  return { code, message, path: pathValue, details };
}

/**
 * Emit a CLI structured error. In `--json` mode it prints the canonical
 * `{ ok: false, error }` envelope to stdout; otherwise it prints a prefixed,
 * human-readable message (plus optional path/detail lines) to stderr. Either
 * way it sets `process.exitCode = 1`.
 */
export function emitCliStructuredError(
  error: CliStructuredError,
  options: { json?: boolean; prefix: string },
): void {
  if (options.json) {
    console.log(JSON.stringify({ ok: false, error }));
  } else {
    console.error(`${options.prefix}: ${error.message}`);
    if (error.path) console.error(`path: ${error.path}`);
    for (const detail of error.details) console.error(`detail: ${detail}`);
  }
  process.exitCode = 1;
}

/** Print a JSON payload to stdout on a single line. */
export function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

/** Shared DI signatures so command modules reference one error-helper contract. */
export type MakeCliStructuredError = typeof makeCliStructuredError;
export type EmitCliStructuredError = typeof emitCliStructuredError;
