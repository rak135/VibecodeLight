import fs from 'fs';
import path from 'path';

/**
 * Shared repository-root resolver used by every Vibecode adapter (CLI,
 * Desktop, and the future MCP server). The resolver picks a single repo path
 * with a stable priority order and validates that the resolved path exists
 * and is a directory.
 *
 * Priority (highest first):
 *   1. `repoArg`            — explicit CLI/IPC argument (`--repo <path>`)
 *   2. `env[envVarName]`    — `VIBECODE_REPO` by default
 *   3. `cwd`                — current working directory fallback
 *
 * The resolver never spawns a process and never reads filesystem state other
 * than a single `fs.statSync` of the resolved path.
 */

export type RepoRootSource = 'arg' | 'env' | 'cwd';

export interface RepoRootResolveOptions {
  /** Explicit `--repo` argument or equivalent IPC parameter. Highest priority. */
  repoArg?: string;
  /** Env source for the env-var fallback. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Name of the env var checked when `repoArg` is absent. Defaults to
   * `VIBECODE_REPO` — kept configurable so that the future MCP server, if it
   * needs a distinct env var, can pass one without forking the resolver.
   */
  envVarName?: string;
  /** Current working directory fallback. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface RepoRootResolveSuccess {
  ok: true;
  repoRoot: string;
  source: RepoRootSource;
}

export type RepoRootErrorCode = 'REPO_NOT_FOUND' | 'REPO_NOT_A_DIRECTORY';

export interface RepoRootResolveError {
  ok: false;
  error: {
    code: RepoRootErrorCode;
    message: string;
    resolvedPath: string;
    details: string[];
  };
}

export type RepoRootResolveResult = RepoRootResolveSuccess | RepoRootResolveError;

export const DEFAULT_REPO_ROOT_ENV_VAR = 'VIBECODE_REPO';

function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function describeSource(source: RepoRootSource, envVarName: string): string {
  if (source === 'arg') return '--repo argument';
  if (source === 'env') return `${envVarName} env`;
  return 'current working directory';
}

/**
 * Resolve the repository root path with priority `repoArg > env > cwd`.
 * Returns a structured success or error object — never throws.
 */
export function resolveRepoRoot(options: RepoRootResolveOptions = {}): RepoRootResolveResult {
  const env = options.env ?? process.env;
  const envVarName = options.envVarName ?? DEFAULT_REPO_ROOT_ENV_VAR;
  const cwd = options.cwd ?? process.cwd();

  const argValue = trimOrUndefined(options.repoArg);
  const envValue = trimOrUndefined(env[envVarName]);

  let rawPath: string;
  let source: RepoRootSource;
  if (argValue !== undefined) {
    rawPath = argValue;
    source = 'arg';
  } else if (envValue !== undefined) {
    rawPath = envValue;
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
          `Resolved from: ${describeSource(source, envVarName)}`,
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
        details: [
          `Path: ${resolvedPath}`,
          'Expected a directory (project/repository root).',
        ],
      },
    };
  }

  return { ok: true, repoRoot: resolvedPath, source };
}
