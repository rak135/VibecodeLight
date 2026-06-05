import fs from 'fs';

import { getRunInfo, type RunInfo } from '../../../core/runs/run_display.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  RUN_GET_INPUT_SCHEMA,
  validateNonEmptyString,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

const TOOL_NAME = 'vibecode_run_get';
const ALLOWED_KEYS = new Set(['run_id']);

function shapeRunInfo(info: RunInfo): Record<string, unknown> {
  return {
    run_id: info.run_id,
    task: info.task,
    repo_root: info.repo_root,
    created_at: info.created_at,
    run_dir: info.runDir,
    has_final_prompt: info.has_final_prompt,
    has_send_metadata: info.has_send_metadata,
    artifacts: {
      user_prompt: Boolean(info.artifacts.user_prompt),
      run_manifest: Boolean(info.artifacts.run_manifest),
      scanner_config: Boolean(info.artifacts.scanner_config),
      flash_input: Boolean(info.artifacts.flash_input),
      flash_output: Boolean(info.artifacts.flash_output),
      context_pack: Boolean(info.artifacts.context_pack),
      selected_skills: Boolean(info.artifacts.selected_skills),
      final_prompt: Boolean(info.artifacts.final_prompt),
      send_metadata: Boolean(info.artifacts.send_metadata),
      codegraph_usage: Boolean(info.artifacts.codegraph_usage),
      codegraph_context: Boolean(info.artifacts.codegraph_context),
      codegraph_repo_atlas: Boolean(info.artifacts.codegraph_repo_atlas),
    },
    codegraph: {
      mode: info.codegraph.mode ?? null,
      used_for_context: info.codegraph.usedForContext,
      state: info.codegraph.state,
      usage_reason: info.codegraph.usageReason,
      warnings: info.codegraph.warnings,
    },
  };
}

function renderText(data: Record<string, unknown>): string {
  const lines: string[] = ['# Vibecode run', ''];
  lines.push(`run_id: ${data.run_id}`);
  lines.push(`task: ${data.task}`);
  lines.push(`created_at: ${data.created_at}`);
  lines.push(`run_dir: ${data.run_dir}`);
  lines.push('');
  const artifacts = data.artifacts as Record<string, boolean>;
  lines.push('artifacts present:');
  for (const [k, v] of Object.entries(artifacts)) lines.push(`  ${k}: ${v ? 'yes' : 'no'}`);
  return lines.join('\n');
}

export function buildRunGetTool(): McpToolDefinition {
  const inputSchema: JsonSchema = RUN_GET_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode run (get)',
    description:
      'Show one Vibecode run by id, or use the alias "latest"/"current". Read-only. Use this before reading artifacts to see which ones exist for the run.',
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
      const runId = validateNonEmptyString(args.run_id, 'run_id');
      if (!runId.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', runId.message),
        });
      }

      const selected = selectRunForMcp({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        selector: runId.value,
        durationMsRef: () => Date.now() - started,
      });
      if (!selected.ok) return selected.error;

      if (!fs.existsSync(selected.runDir)) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('RUN_NOT_FOUND', `run not found: ${selected.runId}`),
        });
      }

      const info = getRunInfo(selected.runDir);
      const data = shapeRunInfo(info);
      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(data),
        data,
        durationMs: Date.now() - started,
      });
    },
  };
}
