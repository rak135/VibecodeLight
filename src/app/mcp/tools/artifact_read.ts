import fs from 'fs';

import { readRunArtifactChunk } from '../../../core/runs/artifact_pagination.js';
import { RUN_SHOW_ARTIFACTS } from '../../../core/runs/run_artifacts.js';
import { HARD_MAX_ARTIFACT_CHUNK_BYTES } from '../../../core/runs/artifact_pagination.js';
import { buildMcpError } from '../errors.js';
import { MCP_TEXT_OUTPUT_LIMIT, formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  ARTIFACT_READ_INPUT_SCHEMA,
  rejectUnknownKeys,
  validateBoundedInteger,
  validateNonEmptyString,
  validateNonNegativeInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

const TOOL_NAME = 'vibecode_artifact_read';
const ALLOWED_KEYS = new Set(['run_id', 'artifact', 'byte_offset', 'max_bytes']);

/**
 * Default max bytes returned per chunk when the caller does not specify one.
 * Keeps responses bounded for model consumption without forcing the agent to
 * compute byte budgets up-front. Aliased to the shared MCP text bound from
 * format.ts (single source of truth) so a default-sized chunk and the wrapping
 * text content stay within the same envelope budget and cannot drift apart.
 */
export const DEFAULT_MAX_BYTES = MCP_TEXT_OUTPUT_LIMIT;

export function buildArtifactReadTool(): McpToolDefinition {
  const inputSchema: JsonSchema = ARTIFACT_READ_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode artifact (read)',
    description:
      'Read one allowlisted Vibecode run artifact (final_prompt, context_pack, flash_output, codegraph, task-intent, …) as a bounded, UTF-8-safe chunk. Prefer this over manually opening .vibecode files. Read-only. run_id accepts "latest"/"current". For large artifacts, continue with byte_offset=<next_byte_offset> until has_more=false; chained chunks reconstruct the exact file.',
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
      const byteOffset = validateNonNegativeInteger(args.byte_offset, 'byte_offset');
      if (!byteOffset.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', byteOffset.message),
        });
      }
      const maxBytes = validateBoundedInteger(args.max_bytes, 'max_bytes', HARD_MAX_ARTIFACT_CHUNK_BYTES);
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

      const read = readRunArtifactChunk(selected.runDir, artifact.value, {
        allowlist: RUN_SHOW_ARTIFACTS,
        applyAliases: true,
        byteOffset: byteOffset.value ?? 0,
        maxBytes: maxBytes.value ?? DEFAULT_MAX_BYTES,
      });

      if (!read.ok) {
        let code: Parameters<typeof buildMcpError>[0];
        switch (read.error.code) {
          case 'ARTIFACT_NOT_ALLOWED':
          case 'PATH_OUTSIDE_RUN':
            code = 'ARTIFACT_NOT_ALLOWED';
            break;
          case 'ARTIFACT_NOT_FOUND':
            code = 'ARTIFACT_NOT_FOUND';
            break;
          // INVALID_BYTE_OFFSET / INVALID_MAX_BYTES / BYTE_OFFSET_OUT_OF_RANGE are
          // all argument problems relative to the resolved file.
          default:
            code = 'INVALID_ARGUMENT';
            break;
        }
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, read.error.message),
        });
      }

      const chunk = read.value;
      const warnings: string[] = [];
      if (chunk.hasMore) {
        warnings.push(
          `HAS_MORE: read ${chunk.bytesRead}/${chunk.totalBytes} bytes from offset ${chunk.byteOffset}. Continue with byte_offset=${chunk.nextByteOffset}.`,
        );
      }
      const data = {
        run_id: selected.runId,
        run_dir: selected.runDir,
        artifact: artifact.value,
        relative_path: chunk.relativePath,
        absolute_path: chunk.absolutePath,
        byte_offset: chunk.byteOffset,
        requested_max_bytes: chunk.requestedMaxBytes,
        bytes_read: chunk.bytesRead,
        total_bytes: chunk.totalBytes,
        has_more: chunk.hasMore,
        next_byte_offset: chunk.nextByteOffset,
        content_sha256: chunk.contentSha256,
        // Backward-compatible alias: pre-1B-1 callers read `truncated` to mean
        // "the file was larger than what you got back" — now equal to has_more.
        truncated: chunk.hasMore,
        content: chunk.content,
      };
      const headerLines = [
        `# Vibecode artifact: ${chunk.relativePath}`,
        '',
        `run_id: ${selected.runId}`,
        `byte_offset: ${chunk.byteOffset}`,
        `bytes_read: ${chunk.bytesRead}`,
        `total_bytes: ${chunk.totalBytes}`,
        `has_more: ${chunk.hasMore ? 'yes' : 'no'}`,
        `next_byte_offset: ${chunk.nextByteOffset ?? 'null'}`,
        `content_sha256: ${chunk.contentSha256}`,
      ];
      if (chunk.hasMore) {
        headerLines.push(
          `continue: call vibecode_artifact_read again with byte_offset: ${chunk.nextByteOffset}`,
        );
      }
      headerLines.push('', chunk.content);
      const text = headerLines.join('\n');
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
