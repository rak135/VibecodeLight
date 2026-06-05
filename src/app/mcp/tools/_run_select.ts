import { LlmAdapterError } from '../../../adapters/llm/errors.js';
import { resolveRunDir } from '../../../core/runs/run_resolver.js';
import { buildMcpError } from '../errors.js';
import { formatError, type McpToolFormattedResult } from '../format.js';

/**
 * Shared helper for MCP-2 run/artifact tools: accept "latest" or "current" as
 * aliases and route to the core `resolveRunDir`. Returns either the resolved
 * `{runId, runDir}` pair or a fully-formed MCP error envelope so callers can
 * just `return helper.error` on failure.
 */
export type RunSelectionResult =
  | { ok: true; runId: string; runDir: string; alias: 'latest' | 'current' | 'explicit' }
  | { ok: false; error: McpToolFormattedResult };

export function selectRunForMcp(args: {
  tool: string;
  repoRoot: string;
  selector: string;
  durationMsRef: () => number;
}): RunSelectionResult {
  const normalized = args.selector.trim();
  const alias = normalized === 'latest' || normalized === 'current' ? normalized : 'explicit';
  const coreSelector = alias === 'current' ? 'latest' : normalized;

  try {
    const { runId, runDir } = resolveRunDir(args.repoRoot, coreSelector);
    return { ok: true, runId, runDir, alias };
  } catch (err) {
    if (err instanceof LlmAdapterError) {
      const code = err.code === 'RUN_MANIFEST_INVALID' ? 'RUN_MANIFEST_INVALID' : 'RUN_NOT_FOUND';
      return {
        ok: false,
        error: formatError({
          tool: args.tool,
          repoRoot: args.repoRoot,
          warnings: [],
          durationMs: args.durationMsRef(),
          error: buildMcpError(code, err.message),
        }),
      };
    }
    return {
      ok: false,
      error: formatError({
        tool: args.tool,
        repoRoot: args.repoRoot,
        warnings: [],
        durationMs: args.durationMsRef(),
        error: buildMcpError(
          'RUN_NOT_FOUND',
          err instanceof Error ? err.message : String(err),
        ),
      }),
    };
  }
}
