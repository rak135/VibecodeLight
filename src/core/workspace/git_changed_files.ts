import {
  defaultGitReadOnlyRunner,
  type GitReadOnlyRunner,
} from './git_status.js';

/**
 * Read-only git changed-files adapter.
 *
 * This is generic workspace/git infrastructure: it reports the changed files
 * in the working tree and index without ever mutating git state. A later
 * agent-aware finalize/commit guard is expected to consume it, but the helper
 * itself contains no coordination, finalize, or commit policy.
 *
 * Hard rules (mirroring `git_status.ts`):
 *   - NEVER mutates the repository — only `git rev-parse` (read-only) and
 *     `git status --porcelain=v1 -z` (read-only) are spawned;
 *   - never throws on a missing git binary or non-zero exit; failures are
 *     returned as a structured `{ ok: false, warnings }` outcome so callers
 *     can surface a non-fatal warning;
 *   - paths are parsed from `-z` (NUL-delimited) output so paths containing
 *     spaces are safe, and are normalized to repo-relative forward-slash form.
 */

/** A single porcelain status character (`M`, `A`, `D`, `R`, `?`, ` `, …). */
export type GitFileStatusCode = string;

export type GitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'type_changed'
  | 'unknown';

export interface GitChangedFile {
  /** Repo-relative, forward-slash path of the changed file. */
  path: string;
  /** For renames/copies, the source path (also repo-relative, forward-slash). */
  original_path?: string;
  /** Raw porcelain index (staged) status character. */
  index_status: GitFileStatusCode;
  /** Raw porcelain worktree (unstaged) status character. */
  worktree_status: GitFileStatusCode;
  status: GitChangeStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitChangedFilesSuccess {
  ok: true;
  /** Repo top-level, normalized to forward slashes. */
  repo_root: string;
  /** HEAD commit sha, or `null` for a repo with no commits yet. */
  head: string | null;
  files: GitChangedFile[];
  raw_count: number;
}

export interface GitChangedFilesFailure {
  ok: false;
  warnings: string[];
}

export type GitChangedFilesOutcome = GitChangedFilesSuccess | GitChangedFilesFailure;

const GENERATED_RUNTIME_ROOTS = new Set(['.vibecode', '.git', 'node_modules', '.codegraph']);

/** Normalize a repo-relative path to forward slashes, stripping any leading `./`. */
function normalizeRelPath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function classify(x: GitFileStatusCode, y: GitFileStatusCode, untracked: boolean): GitChangeStatus {
  if (untracked) return 'untracked';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'M' || y === 'M') return 'modified';
  if (x === 'T' || y === 'T') return 'type_changed';
  return 'unknown';
}

function buildEntry(
  x: GitFileStatusCode,
  y: GitFileStatusCode,
  filePath: string,
  originalPath: string | undefined,
): GitChangedFile {
  const untracked = x === '?' && y === '?';
  const staged = !untracked && x !== ' ' && x !== '?';
  const unstaged = !untracked && y !== ' ' && y !== '?';
  const entry: GitChangedFile = {
    path: filePath,
    index_status: x,
    worktree_status: y,
    status: classify(x, y, untracked),
    staged,
    unstaged,
    untracked,
  };
  if (originalPath !== undefined) entry.original_path = originalPath;
  return entry;
}

/**
 * Parse `git status --porcelain=v1 -z` output into changed-file entries.
 *
 * Porcelain `-z` entries are NUL-terminated. Each entry begins with two
 * status characters (X = index, Y = worktree), a space, then the path. For a
 * renamed/copied entry the destination path comes first and the *following*
 * NUL-terminated token is the original (source) path — e.g.
 * `RM b.txt\0a.txt\0`. Paths are emitted verbatim under `-z` (no quoting),
 * which is why spaces survive.
 */
export function parsePorcelainZ(stdout: string): GitChangedFile[] {
  const tokens = stdout.split('\0');
  const files: GitChangedFile[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    // Smallest valid entry is "XY P" (status + space + 1-char path); the
    // trailing empty token after the final NUL is skipped here.
    if (token.length < 4) {
      i += 1;
      continue;
    }
    const x = token[0];
    const y = token[1];
    const filePath = normalizeRelPath(token.slice(3));

    let originalPath: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = tokens[i + 1];
      if (next !== undefined && next.length > 0) {
        originalPath = normalizeRelPath(next);
        i += 1;
      }
    }

    files.push(buildEntry(x, y, filePath, originalPath));
    i += 1;
  }

  return files;
}

/**
 * Classify a repo-relative path as a generated / ignored runtime path.
 *
 * Intentionally narrow: it matches only the repo-root runtime directories
 * already treated as generated/ignored by current project conventions
 * (`.vibecode/`, `.git/`, `node_modules/`, `.codegraph/`). This is NOT a
 * general ignore engine. A later finalize guard can use it to filter Vibecode
 * runtime noise out of changed-file reports.
 */
export function isGeneratedOrIgnoredRuntimePath(filePath: string): boolean {
  const normalized = normalizeRelPath(filePath);
  const firstSegment = normalized.split('/')[0];
  return GENERATED_RUNTIME_ROOTS.has(firstSegment);
}

/**
 * Inspect the read-only git changed-files state of the given repo root.
 *
 * Returns either the parsed result or a non-fatal failure with warnings (no
 * git binary, not a git repository, etc.). A repo with no commits is handled
 * gracefully: `head` is `null` while changed/untracked files are still
 * reported.
 */
export function getGitChangedFiles(
  repoRoot: string,
  runner: GitReadOnlyRunner = defaultGitReadOnlyRunner,
): GitChangedFilesOutcome {
  const topLevel = runner(['rev-parse', '--show-toplevel'], repoRoot);
  if (!topLevel.ok) {
    return {
      ok: false,
      warnings: [
        topLevel.stderr.trim().length > 0
          ? `git changed-files unavailable: ${topLevel.stderr.trim().split(/\r?\n/)[0]}`
          : 'git changed-files unavailable: not a git repository or git not installed',
      ],
    };
  }

  // HEAD may legitimately be absent (fresh repo with no commits) — degrade to
  // `null` rather than failing the whole call.
  const headResult = runner(['rev-parse', '--verify', 'HEAD'], repoRoot);
  const head = headResult.ok ? headResult.stdout.trim() : null;

  // `--untracked-files=all` lists each untracked file individually instead of
  // collapsing untracked directories to a single `dir/` entry — a finalize
  // guard needs per-file granularity. Still strictly read-only.
  const status = runner(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoRoot);
  if (!status.ok) {
    return {
      ok: false,
      warnings: [
        status.stderr.trim().length > 0
          ? `git status unavailable: ${status.stderr.trim().split(/\r?\n/)[0]}`
          : 'git status unavailable',
      ],
    };
  }

  const files = parsePorcelainZ(status.stdout);
  return {
    ok: true,
    repo_root: normalizeRelPath(topLevel.stdout.trim()),
    head,
    files,
    raw_count: files.length,
  };
}
