/**
 * Detection-only result shape for the optional CodeGraph code-intelligence tool.
 *
 * Phase 1 is strictly detect-only: VibecodeLight reports whether CodeGraph is
 * available/initialized but never runs `codegraph init/index/sync/watch` and
 * never creates `.codegraph/`. See docs/codegraph.md (Phase 1).
 */
export interface CodeGraphDetection {
  /** True when the `codegraph` command is found / callable. */
  available: boolean;
  /** True when `<repoRoot>/.codegraph/` exists. */
  initialized: boolean;
  /** The command probed (only set when available). */
  command?: string;
  /** Version string reported by `codegraph --version`, when obtainable. */
  version?: string;
  /** Relative directory name when initialized (`.codegraph`). */
  codegraphDir?: string;
  /** Non-fatal warnings. Missing command/dir or probe failures land here. */
  warnings: string[];
}
