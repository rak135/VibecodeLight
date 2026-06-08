import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  HARD_MAX_ARTIFACT_CHUNK_BYTES,
  readRunArtifactChunk,
} from '../../../src/core/runs/artifact_pagination.js';
import { RUN_SHOW_ARTIFACTS } from '../../../src/core/runs/run_artifacts.js';

/**
 * Phase 1B-1: continuation reads for run artifacts.
 *
 * These tests pin the safety-critical invariants of `readRunArtifactChunk`:
 *   - chained reads from offset 0 to EOF reconstruct the exact original file,
 *     including multi-byte UTF-8 content with chunk boundaries that land inside
 *     a code point;
 *   - the slicer never emits a U+FFFD replacement character;
 *   - byte offsets / max bytes are validated as structured errors, not throws;
 *   - the artifact allowlist + path containment from run_artifacts.ts still
 *     governs which files are readable (no scan artifact exposure, no traversal).
 *
 * What breaks if removed: an agent could act on a corrupted/partial artifact, or
 * the continuation contract could silently drift so that chunk N+1 does not pick
 * up exactly where chunk N stopped.
 */

function makeRunDir(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'flash'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'output'), { recursive: true });
  return tmp;
}

function writeArtifact(runDir: string, rel: string, content: string | Buffer): string {
  const abs = path.join(runDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Drive the chunk reader from offset 0 to EOF, returning the joined content. */
function readAll(
  runDir: string,
  selector: string,
  maxBytes: number,
): { content: string; chunks: string[]; offsets: number[] } {
  const chunks: string[] = [];
  const offsets: number[] = [];
  let offset = 0;
  // Guard against an accidental infinite loop in a broken implementation.
  for (let i = 0; i < 100_000; i += 1) {
    const result = readRunArtifactChunk(runDir, selector, {
      allowlist: RUN_SHOW_ARTIFACTS,
      applyAliases: true,
      byteOffset: offset,
      maxBytes,
    });
    if (!result.ok) throw new Error(`unexpected error: ${result.error.code} ${result.error.message}`);
    chunks.push(result.value.content);
    offsets.push(offset);
    if (!result.value.hasMore) {
      expect(result.value.nextByteOffset).toBeNull();
      break;
    }
    expect(result.value.nextByteOffset).not.toBeNull();
    offset = result.value.nextByteOffset as number;
  }
  return { content: chunks.join(''), chunks, offsets };
}

describe('readRunArtifactChunk — single chunk', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-artifact-cont-single-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('small artifact returns in one chunk with has_more=false and next_byte_offset=null', () => {
    const content = '# final\nhello world\n';
    const abs = writeArtifact(runDir, 'output/final_prompt.md', content);
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe(content);
    expect(result.value.byteOffset).toBe(0);
    expect(result.value.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    expect(result.value.totalBytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(result.value.hasMore).toBe(false);
    expect(result.value.nextByteOffset).toBeNull();
    expect(result.value.contentSha256).toBe(sha256(fs.readFileSync(abs)));
    expect(result.value.requestedMaxBytes).toBe(DEFAULT_ARTIFACT_CHUNK_BYTES);
  });

  test('content_sha256 is the hash of the full artifact file, not the returned chunk', () => {
    const content = 'x'.repeat(5000);
    const abs = writeArtifact(runDir, 'output/final_prompt.md', content);
    const fullHash = sha256(fs.readFileSync(abs));
    const first = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: 0,
      maxBytes: 100,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Chunk is only 100 bytes but the hash covers all 5000 bytes.
    expect(first.value.bytesRead).toBe(100);
    expect(first.value.contentSha256).toBe(fullHash);
    expect(first.value.contentSha256).not.toBe(sha256(Buffer.from(first.value.content, 'utf8')));
  });
});

describe('readRunArtifactChunk — ASCII continuation', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-artifact-cont-ascii-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('large ASCII artifact reconstructs exactly across chunks and offsets advance', () => {
    const content = Array.from({ length: 4096 }, (_, i) => `line ${i}\n`).join('');
    writeArtifact(runDir, 'output/context_pack.md', content);

    const first = readRunArtifactChunk(runDir, 'output/context_pack.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: 0,
      maxBytes: 1000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.hasMore).toBe(true);
    expect(first.value.bytesRead).toBe(1000);
    expect(first.value.nextByteOffset).toBe(1000);

    const { content: reconstructed, offsets } = readAll(runDir, 'output/context_pack.md', 1000);
    expect(reconstructed).toBe(content);
    // Offsets must be strictly increasing — each chunk picks up where the last stopped.
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
  });
});

describe('readRunArtifactChunk — UTF-8 boundary safety', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-artifact-cont-utf8-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('multi-byte artifact reconstructs exactly with no replacement characters', () => {
    // Mix of 1/2/3/4-byte UTF-8 sequences so chunk boundaries fall inside code points.
    const unit = 'abc日éf\u{1F600}ghi\n'; // 日 (3B), é (2B), 😀 (4B)
    const content = unit.repeat(500);
    const abs = writeArtifact(runDir, 'flash/flash_output.md', content);
    const totalBytes = fs.readFileSync(abs).length;

    // A deliberately awkward window size that will frequently split code points.
    const { content: reconstructed, chunks } = readAll(runDir, 'flash/flash_output.md', 7);
    expect(reconstructed).toBe(content);
    for (const chunk of chunks) {
      expect(chunk).not.toContain('�');
    }
    // Sanity: chained reconstruction yields the same bytes as the file.
    expect(Buffer.byteLength(reconstructed, 'utf8')).toBe(totalBytes);
  });

  test('a max_bytes smaller than the first code point still makes progress (no zero-length stall)', () => {
    const content = '\u{1F600}\u{1F600}'; // two 4-byte emoji
    writeArtifact(runDir, 'flash/flash_output.md', content);
    const first = readRunArtifactChunk(runDir, 'flash/flash_output.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: 0,
      maxBytes: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Must return at least one full code point even though it exceeds max_bytes.
    expect(first.value.bytesRead).toBe(4);
    expect(first.value.content).toBe('\u{1F600}');
    expect(first.value.hasMore).toBe(true);
    expect(first.value.nextByteOffset).toBe(4);

    const { content: reconstructed } = readAll(runDir, 'flash/flash_output.md', 1);
    expect(reconstructed).toBe(content);
  });
});

describe('readRunArtifactChunk — offset edge cases', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-artifact-cont-edge-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('offset exactly at EOF returns empty content with has_more=false', () => {
    const content = 'hello\n';
    writeArtifact(runDir, 'output/final_prompt.md', content);
    const total = Buffer.byteLength(content, 'utf8');
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: total,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe('');
    expect(result.value.bytesRead).toBe(0);
    expect(result.value.totalBytes).toBe(total);
    expect(result.value.hasMore).toBe(false);
    expect(result.value.nextByteOffset).toBeNull();
  });

  test('offset beyond EOF is a structured BYTE_OFFSET_OUT_OF_RANGE error', () => {
    const content = 'hello\n';
    writeArtifact(runDir, 'output/final_prompt.md', content);
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: Buffer.byteLength(content, 'utf8') + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BYTE_OFFSET_OUT_OF_RANGE');
  });

  test('negative offset is a structured INVALID_BYTE_OFFSET error', () => {
    writeArtifact(runDir, 'output/final_prompt.md', 'hi');
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: -1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_BYTE_OFFSET');
  });

  test('non-integer offset is a structured INVALID_BYTE_OFFSET error', () => {
    writeArtifact(runDir, 'output/final_prompt.md', 'hi');
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      byteOffset: 1.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_BYTE_OFFSET');
  });
});

describe('readRunArtifactChunk — max_bytes validation', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-artifact-cont-max-');
    writeArtifact(runDir, 'output/final_prompt.md', 'hello');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('max_bytes=0 is a structured INVALID_MAX_BYTES error', () => {
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      maxBytes: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_MAX_BYTES');
  });

  test('negative max_bytes is a structured INVALID_MAX_BYTES error', () => {
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      maxBytes: -10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_MAX_BYTES');
  });

  test('max_bytes above the hard cap is a structured INVALID_MAX_BYTES error', () => {
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      maxBytes: HARD_MAX_ARTIFACT_CHUNK_BYTES + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_MAX_BYTES');
  });

  test('max_bytes exactly at the hard cap is accepted', () => {
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
      maxBytes: HARD_MAX_ARTIFACT_CHUNK_BYTES,
    });
    expect(result.ok).toBe(true);
  });
});

describe('readRunArtifactChunk — allowlist + containment (no widening)', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-artifact-cont-sec-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('CLI aliases still resolve (codegraph -> scan/codegraph_usage.json)', () => {
    writeArtifact(runDir, 'scan/codegraph_usage.json', '{"ok":true}');
    const result = readRunArtifactChunk(runDir, 'codegraph', {
      allowlist: RUN_SHOW_ARTIFACTS,
      applyAliases: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relativePath).toBe('scan/codegraph_usage.json');
  });

  test('a path-traversal selector is rejected', () => {
    const result = readRunArtifactChunk(runDir, '../../../etc/passwd', {
      allowlist: RUN_SHOW_ARTIFACTS,
      applyAliases: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['ARTIFACT_NOT_ALLOWED', 'PATH_OUTSIDE_RUN']).toContain(result.error.code);
  });

  test('a non-allowlisted scan artifact is rejected (no scan artifact exposure in this batch)', () => {
    // symbols.json exists on disk but is intentionally NOT in RUN_SHOW_ARTIFACTS.
    writeArtifact(runDir, 'scan/symbols.json', '{"symbols":[]}');
    const result = readRunArtifactChunk(runDir, 'scan/symbols.json', {
      allowlist: RUN_SHOW_ARTIFACTS,
      applyAliases: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('an allowlisted but missing artifact returns ARTIFACT_NOT_FOUND', () => {
    const result = readRunArtifactChunk(runDir, 'output/final_prompt.md', {
      allowlist: RUN_SHOW_ARTIFACTS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ARTIFACT_NOT_FOUND');
  });
});
