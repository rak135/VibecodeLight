import { spawnSync } from 'child_process';

/**
 * Read-only git inspector used by the MCP-3 workspace_status tool (and any
 * future read-only orientation tool).
 *
 * Hard rules:
 *   - this module NEVER mutates the repository — no `git add`, no `git
 *     commit`, no `git checkout`, no rebases, no resets;
 *   - the runner only spawns `git` with read-only subcommands
 *     (`rev-parse`, `status --porcelain=v1`);
 *   - the runner returns a structured result; it never throws on a missing
 *     git binary or non-zero exit;
 *   - the public entry point returns either `{ ok: true, ...status }` or
 *     `{ ok: false, warnings: string[] }` with a non-fatal warning so the
 *     caller can surface it as a structured MCP warning rather than a tool
 *     error.
 */

export interface GitReadOnlyRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Synchronous git runner. The first arg is the subcommand, e.g. `rev-parse`. */
export type GitReadOnlyRunner = (args: string[], cwd: string) => GitReadOnlyRunResult;

export interface GitChangedSummary {
  modified: number;
  staged: number;
  untracked: number;
  /** Bounded preview — at most `MAX_FIRST_PATHS` paths, no full diff. */
  first_paths: string[];
}

export interface GitStatusSuccess {
  ok: true;
  branch: string;
  head: string;
  dirty: boolean;
  changed: GitChangedSummary;
}

export interface GitStatusFailure {
  ok: false;
  warnings: string[];
}

export type GitStatusResult = GitStatusSuccess | GitStatusFailure;

const MAX_FIRST_PATHS = 10;
const MAX_GIT_TIMEOUT_MS = 5000;

/** Default git runner that uses `spawnSync('git', ...)`. Never throws. */
export const defaultGitReadOnlyRunner: GitReadOnlyRunner = (args, cwd) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: MAX_GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, stdout: '', stderr: result.error.message, exitCode: null };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
};

/**
 * Parse `git status --porcelain=v1` output into a bounded summary.
 *
 * Porcelain v1 format: two-character status code, single space, path.
 * Index status (X) is staged; worktree status (Y) is modified; `??` is
 * untracked.
 */
export function parsePorcelainV1(stdout: string): GitChangedSummary {
  let modified = 0;
  let staged = 0;
  let untracked = 0;
  const firstPaths: string[] = [];

  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    if (rawLine.length < 3) continue;
    const code = rawLine.slice(0, 2);
    const filePath = rawLine.slice(3);
    if (code === '??') {
      untracked++;
    } else {
      const indexStatus = code[0];
      const worktreeStatus = code[1];
      if (indexStatus !== ' ' && indexStatus !== '?') staged++;
      if (worktreeStatus !== ' ' && worktreeStatus !== '?') modified++;
    }
    if (firstPaths.length < MAX_FIRST_PATHS && filePath.length > 0) {
      firstPaths.push(filePath);
    }
  }
  return { modified, staged, untracked, first_paths: firstPaths };
}

/**
 * Inspect read-only git state of the given repo root. Returns either the
 * summarized status or a non-fatal failure with warnings (no git binary,
 * not a git repo, etc.).
 */
export function getReadOnlyGitStatus(repoRoot: string, runner: GitReadOnlyRunner = defaultGitReadOnlyRunner): GitStatusResult {
  const branch = runner(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (!branch.ok) {
    return {
      ok: false,
      warnings: [
        branch.stderr.trim().length > 0
          ? `git status unavailable: ${branch.stderr.trim().split(/\r?\n/)[0]}`
          : 'git status unavailable: not a git repository or git not installed',
      ],
    };
  }
  const head = runner(['rev-parse', 'HEAD'], repoRoot);
  if (!head.ok) {
    return {
      ok: false,
      warnings: [
        head.stderr.trim().length > 0
          ? `git HEAD unavailable: ${head.stderr.trim().split(/\r?\n/)[0]}`
          : 'git HEAD unavailable',
      ],
    };
  }
  const status = runner(['status', '--porcelain=v1'], repoRoot);
  const changed = status.ok ? parsePorcelainV1(status.stdout) : { modified: 0, staged: 0, untracked: 0, first_paths: [] };
  return {
    ok: true,
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    dirty: changed.modified > 0 || changed.staged > 0 || changed.untracked > 0,
    changed,
  };
}
