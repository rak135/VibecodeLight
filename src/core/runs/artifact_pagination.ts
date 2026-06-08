import { createHash } from 'crypto';
import fs from 'fs';

import {
  resolveRunArtifactPath,
  type ResolveRunArtifactPathOptions,
  type RunArtifactErrorCode,
} from './run_artifacts.js';

/**
 * Phase 1B-1: byte-offset continuation reads for allowlisted run artifacts.
 *
 * This module is the single source of truth for chunked artifact reads shared by
 * the MCP `vibecode_artifact_read` tool and the CLI `vibecode runs artifact-read`
 * command. MCP and CLI are thin adapters over {@link readRunArtifactChunk}; they
 * must NOT re-implement slicing, validation, or UTF-8 boundary logic.
 *
 * It deliberately reuses {@link resolveRunArtifactPath} from `run_artifacts.ts`
 * for allowlist + realpath containment, so continuation reads can never widen the
 * readable surface beyond the existing run-artifact allowlist (no scan-artifact
 * exposure, no source reads, no traversal).
 *
 * Hard guarantees:
 *   - `byteOffset` is a byte offset into the ORIGINAL artifact file.
 *   - `nextByteOffset` is the byte offset of the first byte NOT returned, or null
 *     at EOF. Chained reads from offset 0 following `nextByteOffset` reconstruct
 *     the exact original file, byte for byte.
 *   - returned `content` never splits a UTF-8 code point (the end of the window is
 *     trimmed back to a code-point boundary), so it never contains U+FFFD that was
 *     not already present in the file.
 *   - `contentSha256` is the SHA-256 of the FULL artifact file (not the chunk), so
 *     a caller can verify a reconstructed file across chunks.
 *   - all reads are bounded by {@link HARD_MAX_ARTIFACT_CHUNK_BYTES}.
 */

/**
 * Default max bytes returned per chunk when the caller does not specify one.
 * Matches the shared MCP text output bound (16000) so a default-sized chunk and
 * the MCP envelope's text block stay within the same budget.
 */
export const DEFAULT_ARTIFACT_CHUNK_BYTES = 16_000;

/**
 * Hard ceiling on bytes returned per chunk. Defended here in core (not only in
 * the MCP/CLI adapters) so no adapter can request an unbounded read. 64 KiB is a
 * comfortable upper bound for a single agent-facing chunk while still letting a
 * caller continue through arbitrarily large artifacts.
 */
export const HARD_MAX_ARTIFACT_CHUNK_BYTES = 64 * 1024;

export type RunArtifactChunkErrorCode =
  | RunArtifactErrorCode
  | 'INVALID_BYTE_OFFSET'
  | 'INVALID_MAX_BYTES'
  | 'BYTE_OFFSET_OUT_OF_RANGE';

export interface RunArtifactChunkError {
  code: RunArtifactChunkErrorCode;
  message: string;
  /** Sorted list of allowed selectors, only populated for ARTIFACT_NOT_ALLOWED. */
  allowed?: string[];
  /** Resolved absolute path, populated when meaningful (NOT_FOUND / OUTSIDE_RUN). */
  resolvedPath?: string;
}

export interface ReadRunArtifactChunkOptions
  extends Pick<ResolveRunArtifactPathOptions, 'allowlist' | 'applyAliases'> {
  /** Byte offset into the original artifact file. Default 0. Must be >= 0. */
  byteOffset?: number;
  /**
   * Max bytes of UTF-8 content to return for this chunk. Default
   * {@link DEFAULT_ARTIFACT_CHUNK_BYTES}. Must be a positive integer no greater
   * than {@link HARD_MAX_ARTIFACT_CHUNK_BYTES}.
   */
  maxBytes?: number;
}

export interface RunArtifactChunk {
  /** Allowlist-key form of the selector (forward slashes, alias-resolved). */
  relativePath: string;
  /** Absolute filesystem path inside the run directory. */
  absolutePath: string;
  /** Byte offset this chunk started at (echoes the validated input). */
  byteOffset: number;
  /** The effective max bytes used for this chunk (after defaulting). */
  requestedMaxBytes: number;
  /** Number of bytes actually returned in `content`. */
  bytesRead: number;
  /** Total size of the original artifact file in bytes. */
  totalBytes: number;
  /** Whether more content exists beyond this chunk. */
  hasMore: boolean;
  /** Byte offset of the first byte NOT returned, or null at EOF. */
  nextByteOffset: number | null;
  /** SHA-256 (hex) of the FULL artifact file, stable across chunks. */
  contentSha256: string;
  /** The decoded UTF-8 content for this chunk. */
  content: string;
}

/** A UTF-8 continuation byte has the high bits 10xxxxxx. */
function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Number of bytes in the UTF-8 code point that starts with `lead`. */
function utf8CodePointLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  // Invalid lead byte; advance by one so a corrupt file cannot stall a caller.
  return 1;
}

/**
 * Choose the end index (exclusive) of a chunk that starts at `start`, targets at
 * most `maxBytes`, and never ends inside a UTF-8 code point.
 *
 * The end is trimmed BACKWARD to the nearest code-point boundary so the returned
 * slice decodes cleanly. If trimming would yield zero progress (the window is
 * smaller than the single code point at `start`), the end is extended forward to
 * include exactly that one code point — guaranteeing the caller always advances.
 */
function chooseUtf8ChunkEnd(buffer: Buffer, start: number, maxBytes: number): number {
  const totalBytes = buffer.length;
  let end = Math.min(start + maxBytes, totalBytes);
  if (end < totalBytes) {
    // buffer[end] is the first excluded byte; if it is a continuation byte we are
    // mid-sequence, so walk back to the start of that code point.
    while (end > start && isUtf8ContinuationByte(buffer[end])) {
      end -= 1;
    }
  }
  if (end <= start && start < totalBytes) {
    // Window was smaller than the first code point — emit one whole code point.
    end = Math.min(start + utf8CodePointLength(buffer[start]), totalBytes);
  }
  return end;
}

/**
 * Resolve an allowlisted run-artifact selector and read a bounded, UTF-8-safe
 * chunk starting at `byteOffset`. Errors are returned, never thrown; callers map
 * the structured error into their adapter envelope (MCP tool error / CLI JSON).
 */
export function readRunArtifactChunk(
  runDir: string,
  selector: string,
  options: ReadRunArtifactChunkOptions,
): { ok: true; value: RunArtifactChunk } | { ok: false; error: RunArtifactChunkError } {
  const byteOffset = options.byteOffset ?? 0;
  if (!Number.isInteger(byteOffset) || byteOffset < 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BYTE_OFFSET',
        message: `invalid byte_offset: expected a non-negative integer, got ${JSON.stringify(options.byteOffset)}`,
      },
    };
  }

  const requestedMaxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_CHUNK_BYTES;
  if (!Number.isInteger(requestedMaxBytes) || requestedMaxBytes <= 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MAX_BYTES',
        message: `invalid max_bytes: expected a positive integer, got ${JSON.stringify(options.maxBytes)}`,
      },
    };
  }
  if (requestedMaxBytes > HARD_MAX_ARTIFACT_CHUNK_BYTES) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MAX_BYTES',
        message: `invalid max_bytes: ${requestedMaxBytes} exceeds the hard maximum of ${HARD_MAX_ARTIFACT_CHUNK_BYTES}`,
      },
    };
  }

  const resolved = resolveRunArtifactPath(runDir, selector, {
    allowlist: options.allowlist,
    applyAliases: options.applyAliases,
  });
  if (!resolved.ok) return resolved;

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(resolved.value.absolutePath);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'ARTIFACT_NOT_FOUND',
        message: error instanceof Error ? error.message : String(error),
        resolvedPath: resolved.value.absolutePath,
      },
    };
  }

  const totalBytes = buffer.length;
  const contentSha256 = createHash('sha256').update(buffer).digest('hex');

  if (byteOffset > totalBytes) {
    return {
      ok: false,
      error: {
        code: 'BYTE_OFFSET_OUT_OF_RANGE',
        message: `byte_offset ${byteOffset} is beyond end of artifact (${totalBytes} bytes)`,
        resolvedPath: resolved.value.absolutePath,
      },
    };
  }

  // Offset exactly at EOF: a valid terminal read that returns no more content.
  if (byteOffset === totalBytes) {
    return {
      ok: true,
      value: {
        relativePath: resolved.value.relativePath,
        absolutePath: resolved.value.absolutePath,
        byteOffset,
        requestedMaxBytes,
        bytesRead: 0,
        totalBytes,
        hasMore: false,
        nextByteOffset: null,
        contentSha256,
        content: '',
      },
    };
  }

  const end = chooseUtf8ChunkEnd(buffer, byteOffset, requestedMaxBytes);
  const slice = buffer.subarray(byteOffset, end);
  const bytesRead = slice.length;
  const hasMore = end < totalBytes;

  return {
    ok: true,
    value: {
      relativePath: resolved.value.relativePath,
      absolutePath: resolved.value.absolutePath,
      byteOffset,
      requestedMaxBytes,
      bytesRead,
      totalBytes,
      hasMore,
      nextByteOffset: hasMore ? end : null,
      contentSha256,
      content: slice.toString('utf8'),
    },
  };
}
