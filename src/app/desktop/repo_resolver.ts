import {
  resolveRepoRoot,
  type RepoRootResolveOptions,
  type RepoRootResolveResult,
  type RepoRootSource,
} from '../../core/workspace/repo_root.js';

/**
 * Thin desktop wrapper around the shared core repo-root resolver. Behavior is
 * unchanged from before the refactor — `repoArg > VIBECODE_REPO env > cwd`,
 * with `REPO_NOT_FOUND` / `REPO_NOT_A_DIRECTORY` structured errors — but the
 * implementation now lives in `src/core/workspace/repo_root.ts` so the future
 * MCP server can reuse it without duplicating the resolution rules.
 *
 * Type aliases are preserved so existing imports keep working byte for byte.
 */

export interface RepoResolveOptions {
  /** Explicit --repo CLI argument (highest priority after nothing is provided via env) */
  repoArg?: string;
  /** current working directory (lowest priority fallback) */
  cwd?: string;
}

export type RepoResolveSuccess = Extract<RepoRootResolveResult, { ok: true }>;
export type RepoResolveError = Extract<RepoRootResolveResult, { ok: false }>;
export type RepoResolveResult = RepoRootResolveResult;

/**
 * Resolve the desktop workspace/repo root with explicit priority:
 * 1. repoArg (--repo CLI argument) — highest explicit override
 * 2. VIBECODE_REPO environment variable
 * 3. cwd fallback (lowest priority)
 *
 * Validates that the resolved path exists and is a directory.
 */
export function resolveDesktopRepo(options: RepoResolveOptions = {}): RepoResolveResult {
  const coreOptions: RepoRootResolveOptions = {};
  if (options.repoArg !== undefined) coreOptions.repoArg = options.repoArg;
  if (options.cwd !== undefined) coreOptions.cwd = options.cwd;
  return resolveRepoRoot(coreOptions);
}

export type { RepoRootSource };
