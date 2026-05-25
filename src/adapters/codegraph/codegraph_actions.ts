import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';

import { CODEGRAPH_COMMAND, CODEGRAPH_DIR_NAME, defaultVersionProbe } from './codegraph_cli.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw synchronous runner injected for unit tests. */
export type CodeGraphActionRunner = (
  command: string,
  args: string[],
  cwd: string,
) => CodeGraphRunResult;

export interface CodeGraphRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: string;
}

/** Structured result returned by every action. */
export interface CodeGraphActionResult {
  ok: boolean;
  /** Bounded stdout (max 2 000 chars). */
  stdoutSummary?: string;
  /** Bounded stderr (max 2 000 chars). */
  stderrSummary?: string;
  /** Present when ok=false. */
  error?: { message: string; details?: string };
}

/** Result of the detect-only status action. */
export interface CodeGraphStatusResult {
  ok: boolean;
  available: boolean;
  initialized: boolean;
  version?: string;
  warnings: string[];
  error?: { message: string };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const OUTPUT_LIMIT = 2_000;

function bound(s: string): string {
  if (s.length <= OUTPUT_LIMIT) return s;
  return s.slice(0, OUTPUT_LIMIT - 3) + '...';
}

/** Default runner that uses spawnSync with Windows .cmd shim support. */
export function defaultActionRunner(command: string, args: string[], cwd: string): CodeGraphRunResult {
  // On Windows, prefer the .cmd shim if bare command has no extension.
  const candidates =
    process.platform === 'win32' && !path.extname(command)
      ? [command, `${command}.cmd`]
      : [command];

  let lastResult: CodeGraphRunResult = { ok: false, stdout: '', stderr: '', exitCode: null };

  for (const candidate of candidates) {
    let raw: ReturnType<typeof spawnSync>;
    if (process.platform === 'win32' && path.extname(candidate).toLowerCase() === '.cmd') {
      const shell = process.env.ComSpec ?? 'cmd.exe';
      raw = spawnSync(shell, ['/d', '/s', '/c', `${candidate} ${args.join(' ')}`], {
        encoding: 'utf8',
        timeout: 60_000,
        cwd,
      });
    } else {
      raw = spawnSync(candidate, args, { encoding: 'utf8', timeout: 60_000, cwd });
    }

    if (raw.error) {
      const msg = raw.error.message ?? String(raw.error);
      if (candidates.length > 1 && /ENOENT/i.test(msg) && candidate !== candidates[candidates.length - 1]) {
        lastResult = { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: msg };
        continue;
      }
      return { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: msg };
    }

    const stdout = typeof raw.stdout === 'string' ? raw.stdout : (raw.stdout?.toString() ?? '');
    const stderr = typeof raw.stderr === 'string' ? raw.stderr : (raw.stderr?.toString() ?? '');
    const exitCode = raw.status ?? null;
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  }

  return lastResult;
}

// ---------------------------------------------------------------------------
// Options shared by all actions
// ---------------------------------------------------------------------------

export interface CodeGraphActionOptions {
  /** Override runner for tests (never spawns a real process). */
  runner?: CodeGraphActionRunner;
  /** Override the codegraph command name. Defaults to 'codegraph'. */
  command?: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Detect-only status check. Read-only — never calls init/index/sync/watch.
 * Uses the version probe (not the action runner) for availability detection,
 * and an fs.existsSync check for initialization.
 */
export async function getCodeGraphStatus(
  repoRoot: string,
  options: CodeGraphActionOptions = {},
): Promise<CodeGraphStatusResult> {
  const command = options.command ?? CODEGRAPH_COMMAND;

  // runner is accepted in options so that tests can verify it is NOT called
  // for init/sync/index/watch. We do not use it for the version probe.
  const warnings: string[] = [];

  // Probe version (read-only)
  let available = false;
  let version: string | undefined;
  try {
    const probe = defaultVersionProbe(command);
    if (probe.found) {
      available = true;
      version = probe.version;
    } else {
      warnings.push(probe.warning ?? 'codegraph not found');
    }
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
  }

  // Check .codegraph/ directory (read-only stat)
  let initialized = false;
  try {
    const dir = path.join(repoRoot, CODEGRAPH_DIR_NAME);
    initialized = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch (err) {
    warnings.push(`CODEGRAPH_DIR_CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: true, available, initialized, version, warnings };
}

/**
 * Initialize CodeGraph for the given repository.
 * Runs: codegraph init -i
 * Must be called only on explicit user action — never automatically.
 */
export async function initializeCodeGraphRepo(
  repoRoot: string,
  options: CodeGraphActionOptions = {},
): Promise<CodeGraphActionResult> {
  const command = options.command ?? CODEGRAPH_COMMAND;
  const runner = options.runner ?? defaultActionRunner;

  const run = runner(command, ['init', '-i'], repoRoot);
  return buildActionResult(run);
}

/**
 * Sync CodeGraph index for the given repository.
 * Runs: codegraph sync
 * Must be called only on explicit user action — never automatically.
 */
export async function syncCodeGraphRepo(
  repoRoot: string,
  options: CodeGraphActionOptions = {},
): Promise<CodeGraphActionResult> {
  const command = options.command ?? CODEGRAPH_COMMAND;
  const runner = options.runner ?? defaultActionRunner;

  const run = runner(command, ['sync'], repoRoot);
  return buildActionResult(run);
}

/**
 * Full re-index of CodeGraph for the given repository.
 * Runs: codegraph index --force
 * Must be called only on explicit user action — never automatically.
 * This may take longer than sync; require confirmation in the GUI.
 */
export async function reindexCodeGraphRepo(
  repoRoot: string,
  options: CodeGraphActionOptions = {},
): Promise<CodeGraphActionResult> {
  const command = options.command ?? CODEGRAPH_COMMAND;
  const runner = options.runner ?? defaultActionRunner;

  const run = runner(command, ['index', '--force'], repoRoot);
  return buildActionResult(run);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildActionResult(run: CodeGraphRunResult): CodeGraphActionResult {
  const stdoutSummary = bound(run.stdout ?? '');
  const stderrSummary = bound(run.stderr ?? '');

  if (run.ok) {
    return { ok: true, stdoutSummary, stderrSummary };
  }

  let message = 'codegraph command failed';
  if (run.spawnError) {
    message = `spawn error: ${run.spawnError}`;
  } else if (stderrSummary) {
    message = stderrSummary.slice(0, 200);
  } else if (run.exitCode !== null) {
    message = `exited with code ${run.exitCode}`;
  }

  return {
    ok: false,
    stdoutSummary,
    stderrSummary,
    error: { message, details: stderrSummary || undefined },
  };
}
