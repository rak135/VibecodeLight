import fs from 'fs';
import path from 'path';

/**
 * Phase 1B-4 — terminal protocol banner / preflight.
 *
 * A fresh agent that opens a Vibecode terminal still needs to know what to do
 * first. This module produces a short, static, ACTIONABLE protocol banner that
 * the desktop terminal shows once at session start. It is guidance only:
 *
 *   - it never registers an agent, claims files, runs the scanner, or executes
 *     any workflow command;
 *   - it never writes to the PTY (the desktop renderer prints it to the xterm
 *     DISPLAY, never into shell stdin);
 *   - it never pollutes JSON CLI output — only the interactive desktop terminal
 *     emits it.
 *
 * The banner points agents at the existing Phase 1A/1B tools (MCP preferred,
 * CLI fallback). It deliberately does not advertise out-of-scope Phase 2+
 * features (subagents, handoff, bulk claims, orchestration). Every `vibecode_*`
 * tool it names is a real registered MCP tool — a test cross-checks this against
 * the canonical registry so a renamed/removed tool fails CI.
 */

/** Environment variable that silences the terminal protocol banner. */
export const TERMINAL_AGENT_BANNER_ENV = 'VIBECODE_AGENT_BANNER';

/**
 * Cheap, read-only preflight facts about a repo, gathered at terminal start.
 * Only `fs.existsSync` checks — no git, no scanner, no arbitrary file reads, no
 * mutation. Safe to compute synchronously on every new terminal session.
 */
export interface TerminalPreflightSummary {
  repo_root: string;
  /** `.vibecode/` exists (the repo has been used with Vibecode before). */
  vibecode_initialized: boolean;
  /** `.vibecode/current/run_manifest.json` exists (a current run is available). */
  current_run_present: boolean;
  /** `.vibecode/coordination/state.json` exists (agents/claims may be active). */
  coordination_state_present: boolean;
  /** The recommended first command for this terminal. */
  next_command: string;
}

export interface TerminalAgentProtocolBannerOptions {
  /** Optional cheap preflight summary rendered as a compact preface line. */
  preflight?: TerminalPreflightSummary;
}

/** The recommended first command an agent runs in a new terminal. */
export const TERMINAL_FIRST_COMMAND =
  'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json';

/**
 * Is the terminal protocol banner enabled for the given environment? Disabled
 * only by an explicit `VIBECODE_AGENT_BANNER` of `0` / `false` / `off`
 * (case-insensitive). Unset / empty / any other value keeps it enabled.
 */
export function isTerminalAgentBannerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[TERMINAL_AGENT_BANNER_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return true;
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

/**
 * Gather the cheap, read-only preflight facts for a repo. Never throws: an
 * unreadable / missing path simply reports everything as absent.
 */
export function getTerminalPreflightSummary(repoRoot: string): TerminalPreflightSummary {
  const resolved = path.resolve(repoRoot);
  const exists = (...segments: string[]): boolean => {
    try {
      return fs.existsSync(path.join(resolved, ...segments));
    } catch {
      return false;
    }
  };
  return {
    repo_root: resolved,
    vibecode_initialized: exists('.vibecode'),
    current_run_present: exists('.vibecode', 'current', 'run_manifest.json'),
    coordination_state_present: exists('.vibecode', 'coordination', 'state.json'),
    next_command: TERMINAL_FIRST_COMMAND,
  };
}

function preflightPreface(summary: TerminalPreflightSummary): string {
  const yesNo = (value: boolean): string => (value ? 'yes' : 'no');
  return (
    `Repo: ${summary.repo_root}` +
    ` | current run: ${yesNo(summary.current_run_present)}` +
    ` | coordination: ${yesNo(summary.coordination_state_present)}`
  );
}

/**
 * Build the short terminal protocol banner. Pass an optional {@link
 * TerminalPreflightSummary} to prepend a compact one-line preface. The body is
 * static and bounded; line endings are `\n` (the desktop renderer normalizes to
 * `\r\n` for the xterm display).
 */
export function getTerminalAgentProtocolBanner(
  options: TerminalAgentProtocolBannerOptions = {},
): string {
  const lines: string[] = [];
  if (options.preflight) {
    lines.push(preflightPreface(options.preflight));
  }
  lines.push(
    'Vibecode agent protocol — do this first in a new terminal:',
    '1. Start: prefer MCP vibecode_session_start, then vibecode_workspace_snapshot; CLI fallback:',
    `   ${TERMINAL_FIRST_COMMAND}`,
    '2. Mode: read_only for research/review, build to edit files.',
    '3. Build agents: call MCP vibecode_build_start with exact paths before editing.',
    '4. Check changes before/after edits with MCP vibecode_changes; CLI fallback: vibecode git changes --agent <agent_id> --json.',
    '5. Orient with scan/artifact tools, not raw rg/find or direct .vibecode reads:',
    '   vibecode scan summary --run current --json',
    '   vibecode runs artifact-read --run current --artifact <artifact> --json',
    '6. Before commit: MCP vibecode_build_finish, then CLI vibecode commit guard.',
    `Do not push unless explicitly asked. (Set ${TERMINAL_AGENT_BANNER_ENV}=0 to silence this banner.)`,
  );
  return lines.join('\n');
}
