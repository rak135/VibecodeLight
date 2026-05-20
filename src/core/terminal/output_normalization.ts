/**
 * output_normalization.ts
 *
 * Helpers for cleaning PTY output before it appears in JSON excerpts or
 * human-readable artifacts.
 *
 * Design constraints:
 * - Preserve meaningful command output (including stderr-like user output).
 * - Preserve Unicode.
 * - Strip ANSI escape sequences for JSON/human excerpts.
 * - Filter known non-actionable PTY infrastructure noise only if safe and explicitly tested.
 * - Do NOT hide real command failures.
 * - Do NOT strip arbitrary stderr.
 */

/**
 * Regex covering the common ANSI/VT100 escape sequence families:
 *  - CSI sequences:  ESC [ ... <final>
 *  - OSC sequences:  ESC ] ... (BEL | ST)
 *  - Simple two-char sequences: ESC <char>
 */
// Based on the well-tested approach of the ansi-regex package (MIT, Sindre Sorhus).
// Handles: CSI (ESC [ ... final), OSC (ESC ] ... BEL/ST), C1 controls, simple ESC codes.
// Matches two-byte ESC sequences only when the next char is not `[` or `]` to avoid
// accidentally swallowing the opening of a real CSI/OSC we haven't captured yet.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;

/**
 * Strip ANSI escape sequences from a string.
 * Preserves plain text, newlines, and Unicode characters.
 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

/**
 * Known PTY infrastructure noise lines.
 * These are ConPTY / node-pty internal messages that are always non-actionable
 * when running inside a non-console host (tsx, vitest, git-bash).
 *
 * Pattern is matched against the trimmed content of each line (case-insensitive).
 */
const KNOWN_PTY_NOISE_PATTERNS: RegExp[] = [
  // ConPTY console-list helper always emits this to stderr in non-console hosts.
  // Matches: "Error: AttachConsole failed" and "AttachConsole failed" (both forms observed).
  /^(?:Error: )?AttachConsole failed$/i,
];

/**
 * Filter known non-actionable PTY noise lines from output.
 *
 * Only removes lines that exactly match a known benign PTY infrastructure
 * message. Does NOT remove arbitrary stderr, real errors, or user output.
 */
export function filterKnownPtyNoise(input: string): string {
  if (input.length === 0) {
    return input;
  }

  const lines = input.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    return !KNOWN_PTY_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  });

  return filtered.join('\n');
}

/**
 * Normalize terminal output for use in clean JSON excerpts or human artifacts.
 *
 * Steps (in order):
 * 1. Strip ANSI escape sequences.
 * 2. (does not filter PTY noise — call filterKnownPtyNoise separately if desired)
 *
 * Preserves: meaningful text, newlines, Unicode.
 * Does not do unbounded transformations.
 */
export function normalizeTerminalOutput(input: string): string {
  return stripAnsi(input);
}
