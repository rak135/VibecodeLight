import { spawnSync } from 'child_process';

/**
 * Narrow git mutation/read adapter for the scoped commit guard (Phase 4B).
 *
 * This is the ONLY module in coordination that runs git-mutating commands, and
 * it is deliberately minimal. Hard rules:
 *   - staging is ALWAYS by explicit pathspec after a `--` separator — never
 *     `git add -A`, never `git add .`, never a broad pathspec;
 *   - it never runs `reset`, `stash`, `clean`, `checkout`, or `restore`;
 *   - paths are passed verbatim as argv elements (no shell), so paths with
 *     spaces survive;
 *   - every command is funnelled through an injectable {@link GitCommandRunner}
 *     so callers/tests can record exactly which git commands were invoked.
 */

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Synchronous git runner. The first arg is the subcommand, e.g. `commit`. */
export type GitCommandRunner = (args: string[], cwd: string) => GitCommandResult;

const MAX_GIT_TIMEOUT_MS = 10000;

/** Default git runner that uses `spawnSync('git', ...)`. Never throws. */
export const defaultGitCommandRunner: GitCommandRunner = (args, cwd) => {
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
 * List the files currently staged in the index, as repo-relative forward-slash
 * paths. Uses `-z` so paths with spaces are safe. Read-only.
 */
export function listStagedFiles(
  repoRoot: string,
  runner: GitCommandRunner = defaultGitCommandRunner,
): { ok: boolean; files: string[]; stderr: string } {
  const result = runner(['diff', '--cached', '--name-only', '-z'], repoRoot);
  if (!result.ok) return { ok: false, files: [], stderr: result.stderr };
  const files = result.stdout
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/\\/g, '/'));
  return { ok: true, files, stderr: '' };
}

/**
 * Stage exactly the given repo-relative paths. Uses `git add --` so every path
 * is an explicit pathspec; never a broad add. A `paths` array containing `-A`,
 * `.`, or an empty/whitespace entry is rejected before spawning git.
 */
export function stagePaths(
  repoRoot: string,
  paths: readonly string[],
  runner: GitCommandRunner = defaultGitCommandRunner,
): GitCommandResult {
  if (paths.length === 0) {
    return { ok: false, stdout: '', stderr: 'no paths to stage', exitCode: null };
  }
  for (const p of paths) {
    if (typeof p !== 'string' || p.trim().length === 0 || p === '-A' || p === '.' || p === '-all' || p === '--all') {
      return { ok: false, stdout: '', stderr: `refusing to stage unsafe pathspec: ${JSON.stringify(p)}`, exitCode: null };
    }
  }
  return runner(['add', '--', ...paths], repoRoot);
}

/** Create a commit with the given full message. Caller validates the message. */
export function commitWithMessage(
  repoRoot: string,
  message: string,
  runner: GitCommandRunner = defaultGitCommandRunner,
): GitCommandResult {
  return runner(['commit', '-m', message], repoRoot);
}

/** Return the current HEAD commit sha, or `null` when HEAD cannot be resolved. */
export function revParseHead(
  repoRoot: string,
  runner: GitCommandRunner = defaultGitCommandRunner,
): string | null {
  const result = runner(['rev-parse', '--verify', 'HEAD'], repoRoot);
  return result.ok ? result.stdout.trim() : null;
}
