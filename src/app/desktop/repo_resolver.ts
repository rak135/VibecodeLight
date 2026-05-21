import fs from 'fs';
import path from 'path';

export interface RepoResolveOptions {
  /** Explicit --repo CLI argument (highest priority after nothing is provided via env) */
  repoArg?: string;
  /** current working directory (lowest priority fallback) */
  cwd?: string;
}

export interface RepoResolveSuccess {
  ok: true;
  repoRoot: string;
  source: 'env' | 'arg' | 'cwd';
}

export interface RepoResolveError {
  ok: false;
  error: {
    code: string;
    message: string;
    resolvedPath: string;
    details: string[];
  };
}

export type RepoResolveResult = RepoResolveSuccess | RepoResolveError;

/**
 * Resolve the desktop workspace/repo root with explicit priority:
 * 1. repoArg (--repo CLI argument) — highest explicit override
 * 2. VIBECODE_REPO environment variable
 * 3. cwd fallback (lowest priority)
 *
 * Validates that the resolved path exists and is a directory.
 */
export function resolveDesktopRepo(options: RepoResolveOptions = {}): RepoResolveResult {
  const { repoArg, cwd = process.cwd() } = options;

  const envRepo = process.env.VIBECODE_REPO?.trim() || undefined;

  let rawPath: string;
  let source: 'env' | 'arg' | 'cwd';

  if (repoArg !== undefined && repoArg.trim().length > 0) {
    rawPath = repoArg.trim();
    source = 'arg';
  } else if (envRepo) {
    rawPath = envRepo;
    source = 'env';
  } else {
    rawPath = cwd;
    source = 'cwd';
  }

  const resolvedPath = path.resolve(rawPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return {
      ok: false,
      error: {
        code: 'REPO_NOT_FOUND',
        message: `repo root does not exist: ${resolvedPath}`,
        resolvedPath,
        details: [
          `Resolved from: ${source === 'arg' ? '--repo argument' : source === 'env' ? 'VIBECODE_REPO env' : 'current working directory'}`,
          `Path: ${resolvedPath}`,
        ],
      },
    };
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: {
        code: 'REPO_NOT_A_DIRECTORY',
        message: `repo root is not a directory: ${resolvedPath}`,
        resolvedPath,
        details: [`Path: ${resolvedPath}`, 'Expected a directory (project/repository root).'],
      },
    };
  }

  return { ok: true, repoRoot: resolvedPath, source };
}
