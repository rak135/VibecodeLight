import fs from 'fs';

import {
  RUN_SHOW_ARTIFACTS,
  readRunArtifactText,
} from '../../../core/runs/run_artifacts.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  ARTIFACT_READ_INPUT_SCHEMA,
  rejectUnknownKeys,
  validateNonEmptyString,
  validatePositiveInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

const TOOL_NAME = 'vibecode_artifact_read';
const ALLOWED_KEYS = new Set(['run_id', 'artifact', 'max_bytes']);

/**
 * Default max bytes returned by the tool when the caller does not specify one.
 * Keeps responses bounded for model consumption without forcing the agent to
 * compute byte budgets up-front. Matches the shared MCP text bound from
 * format.ts so a full artifact and the wrapping text content stay within the
 * same envelope budget.
 */
const DEFAULT_MAX_BYTES = 16_000;

export function buildArtifactReadTool(): McpToolDefinition {
  const inputSchema: JsonSchema = ARTIFACT_READ_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode artifact (read)',
    description:
      'Read one allowlisted Vibecode run artifact (final_prompt, context_pack, flash_output, codegraph, task-intent, …). Prefer this over manually opening .vibecode files. Read-only. run_id accepts "latest"/"current". max_bytes bounds returned content.',
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
      const artifact = validateNonEmptyString(args.artifact, 'artifact');
      if (!artifact.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', artifact.message),
        });
      }
      const maxBytes = validatePositiveInteger(args.max_bytes, 'max_bytes');
      if (!maxBytes.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', maxBytes.message),
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

      const read = readRunArtifactText(selected.runDir, artifact.value, {
        allowlist: RUN_SHOW_ARTIFACTS,
        applyAliases: true,
        maxBytes: maxBytes.value ?? DEFAULT_MAX_BYTES,
      });

      if (!read.ok) {
        const code =
          read.error.code === 'ARTIFACT_NOT_ALLOWED' || read.error.code === 'PATH_OUTSIDE_RUN'
            ? 'ARTIFACT_NOT_ALLOWED'
            : 'ARTIFACT_NOT_FOUND';
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, read.error.message),
        });
      }

      const warnings: string[] = [];
      if (read.value.truncated) {
        warnings.push(`OUTPUT_TRUNCATED: artifact bytes_read=${read.value.bytesRead} bound to max_bytes=${maxBytes.value ?? DEFAULT_MAX_BYTES}`);
      }
      const data = {
        run_id: selected.runId,
        run_dir: selected.runDir,
        relative_path: read.value.relativePath,
        absolute_path: read.value.absolutePath,
        bytes_read: read.value.bytesRead,
        truncated: read.value.truncated,
        content: read.value.content,
      };
      const text = [
        `# Vibecode artifact: ${read.value.relativePath}`,
        '',
        `run_id: ${selected.runId}`,
        `bytes_read: ${read.value.bytesRead}${read.value.truncated ? ' (truncated)' : ''}`,
        '',
        read.value.content,
      ].join('\n');
      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text,
        data,
        warnings,
        durationMs: Date.now() - started,
      });
    },
  };
}
