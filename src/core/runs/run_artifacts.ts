import fs from 'fs';
import path from 'path';

/**
 * Shared run-artifact contract used by every Vibecode adapter (CLI, Desktop,
 * and the future MCP server). All three adapters must call into this module
 * instead of maintaining their own allowlists or path-escape checks — that is
 * the only way to guarantee CLI/Desktop/MCP parity for run-artifact reads.
 *
 * Hard rules enforced here:
 *   - normalize Windows backslash separators in selectors to forward slashes;
 *   - optionally apply CLI-style aliases (`codegraph`, `task-intent`);
 *   - reject any selector that is not in the caller-supplied allowlist;
 *   - reject any resolved path that escapes the supplied run directory;
 *   - never read outside `<runDir>/<allowlisted relative path>`.
 *
 * The module does not own the allowlists themselves — each adapter passes the
 * allowlist it wants enforced. Two stable allowlists are exported below for
 * the current CLI and Desktop wrappers; the MCP server will reuse one of them
 * (most likely `RUN_SHOW_ARTIFACTS`) or compose its own at registration time.
 */

/**
 * CLI-only aliases for the `vibecode runs show --artifact` selector. Desktop
 * and MCP do not apply aliases by default so that a renderer/tool call that
 * sends a literal selector cannot suddenly resolve into a different artifact.
 */
export const RUN_ARTIFACT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // CLI-historical aliases — preserved verbatim.
  codegraph: 'scan/codegraph_usage.json',
  'task-intent': 'task_intent.json',
  // MCP-2 agent-friendly aliases. Each one maps to an already-allowlisted
  // canonical path so the agent does not have to know subdirectory layouts.
  final_prompt: 'output/final_prompt.md',
  context_pack: 'output/context_pack.md',
  flash_input: 'flash/flash_input.md',
  flash_output: 'flash/flash_output.md',
  task_intent: 'task_intent.json',
  selected_skills: 'skills/selected_skills.json',
  send_metadata: 'terminal/send_metadata.json',
  codegraph_usage: 'scan/codegraph_usage.json',
  codegraph_context: 'scan/codegraph_context.md',
  codegraph_repo_atlas: 'scan/codegraph_repo_atlas.md',
  user_prompt: 'user_prompt.md',
  run_manifest: 'run_manifest.json',
});

/**
 * Stable allowlist used by `vibecode runs show --artifact <name>`. Mirrors
 * the historical CLI set so existing scripts and tests keep working byte for
 * byte. Any addition here must be reviewed for path safety (no `..`, no
 * absolute paths, must live under the run directory).
 */
export const RUN_SHOW_ARTIFACTS: ReadonlySet<string> = new Set<string>([
  'user_prompt.md',
  'run_manifest.json',
  'task_intent.json',
  'task_intent.md',
  'scanner_config.json',
  'flash/flash_input.md',
  'flash/flash_output.md',
  'output/context_pack.md',
  'skills/selected_skills.json',
  'output/final_prompt.md',
  'terminal/send_metadata.json',
  'scan/codegraph_usage.json',
  'scan/codegraph_context.md',
  'scan/codegraph_repo_atlas.md',
  'scan/codegraph_repo_atlas.json',
  'scan/repo_atlas.md',
  'scan/repo_atlas.json',
]);

/**
 * Stable allowlist used by the desktop renderer's `artifacts:readRunArtifact`
 * IPC channel. Intentionally narrower than the CLI list — it only exposes
 * artifacts the renderer actually displays. Adding entries here loosens the
 * desktop surface, so do it deliberately.
 */
export const RENDERER_RUN_ARTIFACTS: ReadonlySet<string> = new Set<string>([
  'flash/flash_output.md',
  'flash/provider_error.json',
  'output/context_pack.md',
  'output/final_prompt.md',
  'task_intent.json',
  'task_intent.md',
  'config_resolution.json',
  'flash/flash_output_meta.json',
  'scan/codegraph_usage.json',
  'scan/codegraph_context.md',
  'scan/codegraph_repo_atlas.md',
  'scan/codegraph_repo_atlas.json',
  'scan/repo_atlas.md',
  'scan/repo_atlas.json',
]);

/**
 * Normalize a selector for allowlist comparison. Converts Windows backslashes
 * to forward slashes so callers can pass `flash\flash_output.md` and still
 * match a forward-slash entry in the allowlist. No alias resolution.
 */
export function normalizeRunArtifactSelector(selector: string): string {
  return selector.replace(/\\/g, '/');
}

/**
 * Normalize and apply CLI-style aliases. Use this from the CLI wrapper only;
 * Desktop and MCP should call {@link normalizeRunArtifactSelector} directly so
 * that an external caller cannot exploit alias-based name redirection.
 */
export function resolveRunArtifactAlias(selector: string): string {
  const normalized = normalizeRunArtifactSelector(selector);
  return RUN_ARTIFACT_ALIASES[normalized] ?? normalized;
}

export type RunArtifactErrorCode =
  | 'ARTIFACT_NOT_ALLOWED'
  | 'PATH_OUTSIDE_RUN'
  | 'ARTIFACT_NOT_FOUND';

export interface RunArtifactError {
  code: RunArtifactErrorCode;
  message: string;
  /** Sorted list of allowed selectors, only populated for ARTIFACT_NOT_ALLOWED. */
  allowed?: string[];
  /** Resolved absolute path, populated when meaningful (NOT_FOUND / OUTSIDE_RUN). */
  resolvedPath?: string;
}

export interface RunArtifactResolution {
  /** Allowlist-key form of the selector (forward slashes, alias-resolved). */
  relativePath: string;
  /** Absolute filesystem path inside the run directory. */
  absolutePath: string;
}

export interface ResolveRunArtifactPathOptions {
  /** Allowlist the selector must belong to after normalization. */
  allowlist: ReadonlySet<string>;
  /**
   * When true, apply CLI-style aliases (`codegraph` → `scan/codegraph_usage.json`,
   * `task-intent` → `task_intent.json`). Default: false.
   */
  applyAliases?: boolean;
  /**
   * When true (default) verify the resolved file exists on disk and surface
   * `ARTIFACT_NOT_FOUND` if it does not. Set to false when the caller only
   * wants to resolve the path (for example, to print it).
   */
  requireExists?: boolean;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve real (symlink-followed) paths for the run root and the candidate
 * target and verify the target still lives inside the run root. This defeats
 * symlink/junction escapes that pass the lexical containment check. Resolving
 * the run root too keeps legitimate setups working when the run dir itself
 * lives under a symlinked ancestor (e.g. macOS `/tmp` -> `/private/tmp`).
 */
function enforceRealpathContainment(
  runRoot: string,
  artifactPath: string,
  selector: string,
  relativePath: string,
): { ok: true } | { ok: false; error: RunArtifactError } {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(runRoot);
  } catch {
    return {
      ok: false,
      error: {
        code: 'PATH_OUTSIDE_RUN',
        message: `run directory could not be resolved: ${selector}`,
        resolvedPath: artifactPath,
      },
    };
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(artifactPath);
  } catch {
    // Broken symlink or a file that vanished between existsSync and here.
    // Surface as not-found rather than leaking the lexical path as readable.
    return {
      ok: false,
      error: {
        code: 'ARTIFACT_NOT_FOUND',
        message: `artifact not found: ${relativePath}`,
        resolvedPath: artifactPath,
      },
    };
  }

  if (!isInside(realRoot, realTarget)) {
    return {
      ok: false,
      error: {
        code: 'PATH_OUTSIDE_RUN',
        message: `artifact path resolves outside run directory: ${selector}`,
        resolvedPath: artifactPath,
      },
    };
  }

  return { ok: true };
}

/**
 * Resolve a run-artifact selector to an absolute path under `runDir`.
 *
 * The caller is responsible for verifying that `runDir` itself exists and is
 * the correct run directory — this function only enforces the per-artifact
 * allowlist and the per-artifact path-escape guard.
 */
export function resolveRunArtifactPath(
  runDir: string,
  selector: string,
  options: ResolveRunArtifactPathOptions,
): { ok: true; value: RunArtifactResolution } | { ok: false; error: RunArtifactError } {
  const relativePath = options.applyAliases
    ? resolveRunArtifactAlias(selector)
    : normalizeRunArtifactSelector(selector);

  if (!options.allowlist.has(relativePath)) {
    return {
      ok: false,
      error: {
        code: 'ARTIFACT_NOT_ALLOWED',
        message: `artifact path is not allowed: ${selector}`,
        allowed: Array.from(options.allowlist).sort(),
      },
    };
  }

  const runRoot = path.resolve(runDir);
  const artifactPath = path.resolve(runRoot, ...relativePath.split('/'));
  if (!isInside(runRoot, artifactPath)) {
    return {
      ok: false,
      error: {
        code: 'PATH_OUTSIDE_RUN',
        message: `artifact path resolves outside run directory: ${selector}`,
        resolvedPath: artifactPath,
      },
    };
  }

  const requireExists = options.requireExists ?? true;
  if (requireExists && !fs.existsSync(artifactPath)) {
    return {
      ok: false,
      error: {
        code: 'ARTIFACT_NOT_FOUND',
        message: `artifact not found: ${relativePath}`,
        resolvedPath: artifactPath,
      },
    };
  }

  // Symlink/junction escape guard. The lexical containment check above only
  // validates the *string* path; `fs.readFileSync` (used by every reader) still
  // follows symlinks and directory junctions. A symlink planted at an
  // allowlisted path — or an allowlisted file reached through a symlinked
  // parent directory — could otherwise point outside the run dir and leak an
  // arbitrary file. Resolve the real run root and the real target and re-check
  // containment. Only meaningful when the file actually exists; when
  // requireExists is false the caller only wants the lexical path.
  if (requireExists) {
    const guard = enforceRealpathContainment(runRoot, artifactPath, selector, relativePath);
    if (!guard.ok) return guard;
  }

  return { ok: true, value: { relativePath, absolutePath: artifactPath } };
}

export interface ReadRunArtifactOptions extends ResolveRunArtifactPathOptions {
  /**
   * Optional UTF-8 byte cap on the returned content. When set and the file is
   * larger, the result is truncated and a `truncated: true` flag is returned
   * along with `bytesRead`. Default: no cap.
   */
  maxBytes?: number;
}

export interface RunArtifactRead {
  relativePath: string;
  absolutePath: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
}

/**
 * Resolve a run-artifact selector and read its contents as UTF-8 text.
 *
 * Errors are returned, never thrown. Callers translate the structured error
 * into whatever envelope shape their adapter requires (CLI: LlmAdapterError;
 * Desktop bridge: flat error string; MCP: tool error content block).
 */
export function readRunArtifactText(
  runDir: string,
  selector: string,
  options: ReadRunArtifactOptions,
): { ok: true; value: RunArtifactRead } | { ok: false; error: RunArtifactError } {
  const resolved = resolveRunArtifactPath(runDir, selector, options);
  if (!resolved.ok) return resolved;
  try {
    const buffer = fs.readFileSync(resolved.value.absolutePath);
    const bytesRead = buffer.length;
    if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
      const text = buffer.subarray(0, options.maxBytes).toString('utf8');
      return {
        ok: true,
        value: {
          relativePath: resolved.value.relativePath,
          absolutePath: resolved.value.absolutePath,
          content: text,
          bytesRead,
          truncated: true,
        },
      };
    }
    return {
      ok: true,
      value: {
        relativePath: resolved.value.relativePath,
        absolutePath: resolved.value.absolutePath,
        content: buffer.toString('utf8'),
        bytesRead,
        truncated: false,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'ARTIFACT_NOT_FOUND',
        message: error instanceof Error ? error.message : String(error),
        resolvedPath: resolved.value.absolutePath,
      },
    };
  }
}
