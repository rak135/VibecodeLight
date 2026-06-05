import fs from 'fs';

import {
  RUN_SHOW_ARTIFACTS,
  readRunArtifactText,
} from '../../../core/runs/run_artifacts.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  CODEGRAPH_USAGE_INPUT_SCHEMA,
  rejectUnknownKeys,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

const TOOL_NAME = 'vibecode_codegraph_usage';
const ALLOWED_KEYS = new Set(['run_id']);

interface CodeGraphUsage {
  mode?: string;
  used?: boolean;
  used_for_context?: boolean;
  transport_requested?: string;
  transport_used?: string;
  mcp_attempted?: boolean;
  fallback_used?: boolean;
  fallback_reason?: string;
  reason?: string;
  warnings?: string[];
  context_artifact?: string;
  artifact?: string;
}

function structure(usage: CodeGraphUsage): Record<string, unknown> {
  return {
    mode: usage.mode ?? null,
    used: usage.used ?? false,
    used_for_context: usage.used_for_context ?? usage.used ?? false,
    transport_requested: usage.transport_requested ?? null,
    transport_used: usage.transport_used ?? 'none',
    mcp_attempted: usage.mcp_attempted ?? false,
    fallback_used: usage.fallback_used ?? false,
    fallback_reason: usage.fallback_reason ?? null,
    reason: usage.reason ?? null,
    warnings: Array.isArray(usage.warnings) ? usage.warnings : [],
    context_artifact: usage.context_artifact ?? usage.artifact ?? null,
  };
}

function renderText(runId: string, structured: Record<string, unknown>): string {
  const lines: string[] = ['# Vibecode CodeGraph usage', ''];
  lines.push(`run_id: ${runId}`);
  for (const key of ['mode', 'used', 'used_for_context', 'transport_requested', 'transport_used', 'mcp_attempted', 'fallback_used', 'reason', 'context_artifact'] as const) {
    lines.push(`${key}: ${String(structured[key] ?? '')}`);
  }
  const warnings = structured.warnings as string[];
  if (warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export function buildCodeGraphUsageTool(): McpToolDefinition {
  const inputSchema: JsonSchema = CODEGRAPH_USAGE_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode CodeGraph usage',
    description:
      'Return structured CodeGraph usage for a Vibecode run (mode, transport_requested, transport_used, fallback_used, context_artifact). Defaults to latest/current run. Read-only.',
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

      const rawRunId = typeof args.run_id === 'string' && args.run_id.trim().length > 0 ? args.run_id.trim() : 'latest';
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

      const read = readRunArtifactText(selected.runDir, 'scan/codegraph_usage.json', {
        allowlist: RUN_SHOW_ARTIFACTS,
      });
      if (!read.ok) {
        // Translate the run-artifact error directly into the MCP usage error.
        const code = read.error.code === 'ARTIFACT_NOT_FOUND' ? 'ARTIFACT_NOT_FOUND' : 'ARTIFACT_NOT_ALLOWED';
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, read.error.message),
        });
      }

      let parsed: CodeGraphUsage;
      try {
        parsed = JSON.parse(read.value.content) as CodeGraphUsage;
      } catch (err) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(
            'VIBECODE_ARTIFACT_READ_FAILED',
            `codegraph_usage.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          ),
        });
      }

      const structured = structure(parsed);
      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(selected.runId, structured),
        data: { run_id: selected.runId, run_dir: selected.runDir, ...structured },
        durationMs: Date.now() - started,
      });
    },
  };
}
