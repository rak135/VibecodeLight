import fs from 'fs';

import { readScanArtifactChunk } from '../../../core/runs/scan_artifacts.js';
import { HARD_MAX_ARTIFACT_CHUNK_BYTES } from '../../../core/runs/artifact_pagination.js';
import { buildMcpError } from '../errors.js';
import { MCP_TEXT_OUTPUT_LIMIT, formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  SCAN_ARTIFACT_READ_INPUT_SCHEMA,
  rejectUnknownKeys,
  validateBoundedInteger,
  validateNonEmptyString,
  validateNonNegativeInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

/**
 * Phase 1B-2 — `vibecode_scan_artifact_read`.
 *
 * Read one allowlisted scan artifact (by KEY, never a raw path) in bounded,
 * UTF-8-safe, continuation-friendly chunks. Thin wrapper over the shared core
 * service (`core/runs/scan_artifacts.readScanArtifactChunk`) — the same service
 * the `vibecode scan artifact-read` CLI command uses, so MCP and CLI stay at
 * field-level parity. The continuation contract (byte_offset / next_byte_offset
 * / content_sha256 / hard byte cap) is inherited unchanged from the run-artifact
 * read. Read-only; never runs the scanner; never reads source or non-allowlisted
 * files.
 */
const TOOL_NAME = 'vibecode_scan_artifact_read';
const ALLOWED_KEYS = new Set(['run_id', 'artifact', 'byte_offset', 'max_bytes']);

/** Default max bytes returned per chunk (shared MCP text bound). */
export const DEFAULT_MAX_BYTES = MCP_TEXT_OUTPUT_LIMIT;

export function buildScanArtifactReadTool(): McpToolDefinition {
  const inputSchema: JsonSchema = SCAN_ARTIFACT_READ_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode scan artifact (read)',
    description:
      'Read one allowlisted Vibecode scan artifact (commands, tests, symbols, imports, entrypoints, file_inventory, repo_instructions, tooling, schemas, keyword_hits, git_status, git_diff_stat) by key as a bounded, UTF-8-safe chunk. Prefer this over opening .vibecode/runs/.../scan/*.json by hand. Read-only; never runs the scanner. run_id accepts "latest"/"current". For large artifacts, continue with byte_offset=<next_byte_offset> until has_more=false; chained chunks reconstruct the exact file.',
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

      // run_id is optional; default to current.
      let runSelector = 'current';
      if (args.run_id !== undefined && args.run_id !== null) {
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
        runSelector = runId.value;
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
        selector: runSelector,
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

      // readScanArtifactChunk is documented to return errors rather than throw,
      // but wrap the read + formatting so any unexpected throw (e.g. a transient
      // filesystem fault) maps to the stable SCAN_ARTIFACT_READ_FAILED code
      // instead of escaping as an unhandled rejection.
      let read: ReturnType<typeof readScanArtifactChunk>;
      try {
        read = readScanArtifactChunk(selected.runDir, artifact.value, {
          byteOffset: byteOffset.value ?? 0,
          maxBytes: maxBytes.value ?? DEFAULT_MAX_BYTES,
        });
      } catch (err) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('SCAN_ARTIFACT_READ_FAILED', err instanceof Error ? err.message : String(err)),
        });
      }

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
          default:
            // INVALID_BYTE_OFFSET / INVALID_MAX_BYTES / BYTE_OFFSET_OUT_OF_RANGE
            code = 'INVALID_ARGUMENT';
            break;
        }
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, read.error.message, {
            details: read.error.allowed ? { allowed: read.error.allowed } : undefined,
          }),
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
        artifact: chunk.artifact,
        relative_path: chunk.relativePath,
        absolute_path: chunk.absolutePath,
        byte_offset: chunk.byteOffset,
        requested_max_bytes: chunk.requestedMaxBytes,
        bytes_read: chunk.bytesRead,
        total_bytes: chunk.totalBytes,
        has_more: chunk.hasMore,
        next_byte_offset: chunk.nextByteOffset,
        content_sha256: chunk.contentSha256,
        truncated: chunk.hasMore,
        content: chunk.content,
      };
      const headerLines = [
        `# Vibecode scan artifact: ${chunk.relativePath}`,
        '',
        `run_id: ${selected.runId}`,
        `artifact: ${chunk.artifact}`,
        `byte_offset: ${chunk.byteOffset}`,
        `bytes_read: ${chunk.bytesRead}`,
        `total_bytes: ${chunk.totalBytes}`,
        `has_more: ${chunk.hasMore ? 'yes' : 'no'}`,
        `next_byte_offset: ${chunk.nextByteOffset ?? 'null'}`,
        `content_sha256: ${chunk.contentSha256}`,
      ];
      if (chunk.hasMore) {
        headerLines.push(
          `continue: call vibecode_scan_artifact_read again with byte_offset: ${chunk.nextByteOffset}`,
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
