import fs from 'fs';

import { getRunInfo } from '../../../core/runs/run_display.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  CURRENT_RUN_INPUT_SCHEMA,
  rejectUnknownKeys,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

const TOOL_NAME = 'vibecode_current_run';
const ALLOWED_KEYS = new Set<string>();

function summarizeArtifacts(runDir: string): Record<string, boolean | string> {
  const info = getRunInfo(runDir);
  return {
    run_id: info.run_id,
    run_dir: info.runDir,
    task: info.task,
    created_at: info.created_at,
    has_final_prompt: info.has_final_prompt,
    has_send_metadata: info.has_send_metadata,
    has_context_pack: Boolean(info.artifacts.context_pack),
    has_selected_skills: Boolean(info.artifacts.selected_skills),
    has_flash_output: Boolean(info.artifacts.flash_output),
    has_codegraph_usage: Boolean(info.artifacts.codegraph_usage),
    has_codegraph_context: Boolean(info.artifacts.codegraph_context),
  };
}

function renderText(data: Record<string, boolean | string>): string {
  const lines: string[] = ['# Vibecode current run', ''];
  lines.push(`run_id: ${data.run_id}`);
  lines.push(`task: ${data.task}`);
  lines.push(`created_at: ${data.created_at}`);
  lines.push(`run_dir: ${data.run_dir}`);
  lines.push('');
  lines.push('artifacts present:');
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'boolean') lines.push(`  ${k}: ${v ? 'yes' : 'no'}`);
  }
  lines.push('');
  lines.push('Read individual artifacts via vibecode_artifact_read (artifact ∈ {final_prompt, context_pack, flash_output, ...}).');
  return lines.join('\n');
}

export function buildCurrentRunTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CURRENT_RUN_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode current run',
    description:
      'Return the current/latest Vibecode run pointer and which run artifacts are present (final_prompt, context_pack, flash_output, codegraph_usage, etc.). Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', unknown.message),
        });
      }

      const selected = selectRunForMcp({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        selector: 'latest',
        durationMsRef: () => Date.now() - started,
      });
      if (!selected.ok) return selected.error;

      if (!fs.existsSync(selected.runDir)) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('RUN_NOT_FOUND', `run directory does not exist: ${selected.runId}`),
        });
      }

      const data = summarizeArtifacts(selected.runDir);
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
