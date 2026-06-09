import fs from 'fs';

import {
  readRunArtifactChunk,
  type RunArtifactChunk,
  type RunArtifactChunkError,
} from './artifact_pagination.js';
import { resolveRunArtifactPath } from './run_artifacts.js';

/**
 * Phase 1B-2: strict, allowlisted access to deterministic scanner artifacts.
 *
 * This module is the single source of truth for which scan artifacts agents may
 * read through MCP/CLI and how their KEY maps to a run-relative path. It is the
 * scan-side analogue of `run_artifacts.ts` + `artifact_pagination.ts`:
 *
 *   - the public surface is a fixed allowlist of artifact KEYS (e.g. `commands`),
 *     never raw paths. An agent cannot pass `scan/<anything>` or a traversal
 *     string — only a key that resolves to a known `scan/<file>` relative path;
 *   - chunked reads reuse {@link readRunArtifactChunk} verbatim (byte offsets,
 *     UTF-8-safe slicing, full-file hashing, hard byte caps) so the scan-read and
 *     run-artifact-read continuation contracts cannot drift;
 *   - the relative paths are passed through the SAME `resolveRunArtifactPath`
 *     allowlist + realpath containment guard, with a scan-only allowlist set, so
 *     a key can never widen the readable surface to a source file, a
 *     non-allowlisted scan file, or anything outside the run directory.
 *
 * It does NOT run the scanner. It only reads artifacts an earlier scan produced.
 *
 * The mapped filenames are the real names the Python scanner writes under
 * `.vibecode/runs/<run_id>/scan/` (see the scanner's `scan/base_scan.py`). Keys
 * whose artifact a given run did not produce are reported as missing, never
 * invented.
 */

/** Strict scan-artifact allowlist: agent-facing KEY -> run-relative path. */
export const SCAN_ARTIFACT_ALLOWLIST = Object.freeze({
  file_inventory: 'scan/file_inventory.json',
  commands: 'scan/commands.json',
  repo_instructions: 'scan/repo_instructions.json',
  symbols: 'scan/symbols.json',
  imports: 'scan/imports.json',
  entrypoints: 'scan/entrypoints.json',
  tests: 'scan/tests.json',
  tooling: 'scan/tooling.json',
  schemas: 'scan/schemas.json',
  keyword_hits: 'scan/keyword_hits.json',
  git_status: 'scan/git_status.json',
  git_diff_stat: 'scan/git_diff_stat.txt',
} as const);

export type ScanArtifactKey = keyof typeof SCAN_ARTIFACT_ALLOWLIST;

/** All allowlisted scan-artifact keys, in declaration order. */
export const SCAN_ARTIFACT_KEYS: readonly ScanArtifactKey[] = Object.freeze(
  Object.keys(SCAN_ARTIFACT_ALLOWLIST) as ScanArtifactKey[],
);

/**
 * Run-relative paths reachable through the scan allowlist. Used as the
 * `allowlist` argument to the shared resolver/chunk reader so the scan surface
 * is enforced with the exact same containment logic as the run-artifact surface
 * (no traversal, no symlink escape, no source/non-allowlisted exposure).
 */
export const SCAN_ARTIFACT_RELATIVE_PATHS: ReadonlySet<string> = Object.freeze(
  new Set<string>(Object.values(SCAN_ARTIFACT_ALLOWLIST)),
);

/** Narrow an arbitrary value to a known scan-artifact key. */
export function isScanArtifactKey(value: unknown): value is ScanArtifactKey {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SCAN_ARTIFACT_ALLOWLIST, value)
  );
}

export interface ScanArtifactInfo {
  key: ScanArtifactKey;
  relative_path: string;
  available: boolean;
  size_bytes: number | null;
}

/**
 * Report, for every allowlisted scan artifact, whether it exists for this run
 * and its size. Read-only; never throws.
 *
 * Availability uses `lstatSync` (NOT `statSync`), so a symlink planted at an
 * allowlisted path is NOT reported as a normal available artifact even though a
 * symlink target might exist — `lstat` describes the link itself, whose
 * `isFile()` is false. This keeps the advisory listing from advertising a file
 * the authoritative read-time guard would then reject. Read-time containment
 * (`readScanArtifactChunk` → `resolveRunArtifactPath` with `requireExists:true`,
 * which realpath-resolves and rejects symlink escapes) remains the final
 * security boundary; this listing is only an availability hint.
 */
export function listAllowedScanArtifacts(runDir: string): ScanArtifactInfo[] {
  return SCAN_ARTIFACT_KEYS.map((key) => {
    const relativePath = SCAN_ARTIFACT_ALLOWLIST[key];
    const resolved = resolveRunArtifactPath(runDir, relativePath, {
      allowlist: SCAN_ARTIFACT_RELATIVE_PATHS,
      applyAliases: false,
      requireExists: false,
    });
    if (!resolved.ok) {
      return { key, relative_path: relativePath, available: false, size_bytes: null };
    }
    try {
      // lstat, not stat: a symlink (even to a real file) is reported as a
      // non-file so the advisory listing never advertises an unsafe artifact.
      const stat = fs.lstatSync(resolved.value.absolutePath);
      const isPlainFile = stat.isFile();
      return {
        key,
        relative_path: relativePath,
        available: isPlainFile,
        size_bytes: isPlainFile ? stat.size : null,
      };
    } catch {
      return { key, relative_path: relativePath, available: false, size_bytes: null };
    }
  });
}

export interface ScanArtifactJson {
  /** Whether the artifact file exists and was readable. */
  available: boolean;
  /** Parsed JSON value for `.json` artifacts, or null. */
  value: unknown;
  /** Raw text for `.txt` artifacts (git_diff_stat), or null. */
  text: string | null;
  /** Populated when the file exists but could not be read/parsed. */
  error?: string;
}

/**
 * Read and parse a single allowlisted scan artifact for summary use. Read-only;
 * never throws. A missing file yields `{ available: false }`; a malformed JSON
 * file yields `{ available: true, value: null, error }` so the caller can mark
 * that one section unavailable without failing the whole summary.
 */
export function readScanArtifactJson(runDir: string, key: ScanArtifactKey): ScanArtifactJson {
  const relativePath = SCAN_ARTIFACT_ALLOWLIST[key];
  const resolved = resolveRunArtifactPath(runDir, relativePath, {
    allowlist: SCAN_ARTIFACT_RELATIVE_PATHS,
    applyAliases: false,
    requireExists: true,
  });
  if (!resolved.ok) {
    return { available: false, value: null, text: null };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolved.value.absolutePath, 'utf8');
  } catch (err) {
    return {
      available: false,
      value: null,
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (relativePath.endsWith('.txt')) {
    return { available: true, value: null, text: raw };
  }
  try {
    return { available: true, value: JSON.parse(raw), text: null };
  } catch (err) {
    return {
      available: true,
      value: null,
      text: null,
      error: `invalid JSON in ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ReadScanArtifactChunkOptions {
  /** Byte offset into the original artifact file. Default 0. */
  byteOffset?: number;
  /** Max bytes of UTF-8 content to return for this chunk. */
  maxBytes?: number;
}

export interface ScanArtifactChunk extends RunArtifactChunk {
  /** The allowlisted scan-artifact key this chunk was read from. */
  artifact: ScanArtifactKey;
}

/**
 * Read a bounded, UTF-8-safe chunk of an allowlisted scan artifact. The `key`
 * must be one of {@link SCAN_ARTIFACT_KEYS}; unknown keys (including raw paths
 * and traversal strings) are rejected with `ARTIFACT_NOT_ALLOWED` and never
 * touch the filesystem. Continuation semantics (`byteOffset`, `nextByteOffset`,
 * `contentSha256`, hard byte cap) are inherited unchanged from
 * {@link readRunArtifactChunk}. Errors are returned, never thrown.
 */
export function readScanArtifactChunk(
  runDir: string,
  key: string,
  options: ReadScanArtifactChunkOptions = {},
): { ok: true; value: ScanArtifactChunk } | { ok: false; error: RunArtifactChunkError } {
  if (!isScanArtifactKey(key)) {
    return {
      ok: false,
      error: {
        code: 'ARTIFACT_NOT_ALLOWED',
        message: `scan artifact is not allowed: ${key}`,
        allowed: [...SCAN_ARTIFACT_KEYS].sort(),
      },
    };
  }
  const relativePath = SCAN_ARTIFACT_ALLOWLIST[key];
  const read = readRunArtifactChunk(runDir, relativePath, {
    allowlist: SCAN_ARTIFACT_RELATIVE_PATHS,
    applyAliases: false,
    byteOffset: options.byteOffset,
    maxBytes: options.maxBytes,
  });
  if (!read.ok) return read;
  return { ok: true, value: { artifact: key, ...read.value } };
}
