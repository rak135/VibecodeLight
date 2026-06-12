import { listRuns, type RunInfo } from '../../../core/runs/run_display.js';
import { getWorkspacePaths } from '../../../core/workspace/paths.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  RUNS_LIST_INPUT_SCHEMA,
  validatePositiveInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_runs_list';
const ALLOWED_KEYS = new Set(['limit']);

function summarizeRun(info: RunInfo): Record<string, unknown> {
  return {
    run_id: info.run_id,
    created_at: info.created_at,
    task: info.task,
    has_final_prompt: info.has_final_prompt,
    has_send_metadata: info.has_send_metadata,
    has_context_pack: Boolean(info.artifacts.context_pack),
    has_codegraph_usage: Boolean(info.artifacts.codegraph_usage),
    codegraph: {
      mode: info.codegraph.mode ?? null,
      used_for_context: info.codegraph.usedForContext,
      state: info.codegraph.state,
    },
  };
}

function renderText(runs: Array<ReturnType<typeof summarizeRun>>): string {
  const lines: string[] = ['# Vibecode runs', ''];
  if (runs.length === 0) {
    lines.push('(no runs yet — call `vibecode_run_status` after running `vibecode prompt` or `vibecode context-build`)');
    return lines.join('\n');
  }
  for (const r of runs) {
    const task = typeof r.task === 'string' && r.task.length > 80 ? `${r.task.slice(0, 77)}...` : r.task;
    lines.push(`- ${r.run_id}  (${r.created_at})  has_final_prompt=${r.has_final_prompt}  task: ${task}`);
  }
  return lines.join('\n');
}

export function buildRunsListTool(): McpToolDefinition {
  const inputSchema: JsonSchema = RUNS_LIST_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode runs (list)',
    description:
      'List recent Vibecode runs for the bound repo, newest first. Prefer this over scanning .vibecode/runs/ by hand. Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const args = (input.arguments ?? {}) as Record<string, unknown>;

      const unknown = rejectUnknownKeys(args, ALLOWED_KEYS);
      if (!unknown.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', unknown.message),
        });
      }
      const limit = validatePositiveInteger(args.limit, 'limit');
      if (!limit.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', limit.message),
        });
      }

      const paths = getWorkspacePaths(input.context.repoRoot);
      const allRuns = listRuns(paths.vibecode, paths.runs);
      const trimmed = limit.value !== undefined ? allRuns.slice(0, limit.value) : allRuns;
      const summaries = trimmed.map(summarizeRun);

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(summaries),
        data: { runs: summaries, total: allRuns.length, returned: summaries.length },
        durationMs: Date.now() - started,
      });
    },
  };
}
