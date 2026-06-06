import fs from 'fs';

import { listRunArtifacts } from '../../../core/runs/run_artifact_groups.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  ARTIFACTS_LIST_INPUT_SCHEMA,
  rejectUnknownKeys,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

const TOOL_NAME = 'vibecode_artifacts_list';
const ALLOWED_KEYS = new Set(['run_id']);

function renderText(runId: string, summary: ReturnType<typeof listRunArtifacts>): string {
  const lines: string[] = [`# Vibecode artifacts for run ${runId}`, ''];
  lines.push('available artifacts:');
  for (const entry of summary.artifacts) {
    const size = entry.size_bytes === null ? 'n/a' : `${entry.size_bytes}B`;
    lines.push(`  - ${entry.name} (${entry.path})  exists=${entry.exists ? 'yes' : 'no'} size=${size} group=${entry.group}${entry.recommended_for_agent ? ' [recommended]' : ''}`);
  }
  lines.push('');
  lines.push(`recommended_next_reads: ${summary.recommended_next_reads.join(', ')}`);
  return lines.join('\n');
}

export function buildArtifactsListTool(): McpToolDefinition {
  const inputSchema: JsonSchema = ARTIFACTS_LIST_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode artifacts (list)',
    description:
      'List the allowlisted artifacts for a Vibecode run (with exists/size/group/recommendation) so agents do not need to guess artifact names before calling vibecode_artifact_read. Defaults to latest/current run. Read-only — never returns artifact content.',
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

      const rawRunId =
        typeof args.run_id === 'string' && args.run_id.trim().length > 0 ? args.run_id.trim() : 'latest';
      const selected = selectRunForMcp({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        selector: rawRunId,
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

      const summary = listRunArtifacts(selected.runDir);
      const data = {
        run_id: selected.runId,
        run_dir: selected.runDir,
        artifacts: summary.artifacts,
        groups: summary.groups,
        recommended_next_reads: summary.recommended_next_reads,
      };
      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(selected.runId, summary),
        data,
        durationMs: Date.now() - started,
      });
    },
  };
}
