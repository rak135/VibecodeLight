import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  SCAN_ARTIFACT_ALLOWLIST,
  SCAN_ARTIFACT_KEYS,
  listAllowedScanArtifacts,
  readScanArtifactChunk,
  readScanArtifactJson,
} from '../../../src/core/runs/scan_artifacts.js';

/**
 * Phase 1B-2: allowlisted scan-artifact access.
 *
 * Pins the safety-critical invariants of the scan-artifact surface:
 *   - only the fixed KEY allowlist is readable; raw paths, traversal strings,
 *     source files, and non-allowlisted scan files are rejected without touching
 *     the filesystem or widening the readable surface;
 *   - chunked reads reuse the run-artifact continuation contract (byte offsets,
 *     UTF-8 safety, full-file hash) so a large scan artifact reconstructs exactly;
 *   - the allowlist still names the real artifacts the scanner produces.
 *
 * What breaks if removed: an agent could read arbitrary source files through a
 * crafted scan key, or the scan-read continuation could drift from run-read.
 */

function makeRunDir(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmp, 'scan'), { recursive: true });
  return tmp;
}

function writeScan(runDir: string, rel: string, content: string | Buffer): string {
  const abs = path.join(runDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('scan artifact allowlist', () => {
  test('maps the real scanner artifact names under scan/', () => {
    // These are the names the Python scanner writes (base_scan.py). If the
    // scanner renames an artifact, this test must be revisited deliberately.
    expect(SCAN_ARTIFACT_ALLOWLIST.commands).toBe('scan/commands.json');
    expect(SCAN_ARTIFACT_ALLOWLIST.file_inventory).toBe('scan/file_inventory.json');
    expect(SCAN_ARTIFACT_ALLOWLIST.tests).toBe('scan/tests.json');
    expect(SCAN_ARTIFACT_ALLOWLIST.symbols).toBe('scan/symbols.json');
    expect(SCAN_ARTIFACT_ALLOWLIST.git_diff_stat).toBe('scan/git_diff_stat.txt');
    for (const rel of Object.values(SCAN_ARTIFACT_ALLOWLIST)) {
      expect(rel.startsWith('scan/')).toBe(true);
    }
  });

  test('every key resolves under the run scan directory', () => {
    expect(SCAN_ARTIFACT_KEYS).toContain('commands');
    expect(SCAN_ARTIFACT_KEYS).toContain('keyword_hits');
    expect(SCAN_ARTIFACT_KEYS.length).toBe(Object.keys(SCAN_ARTIFACT_ALLOWLIST).length);
  });
});

describe('listAllowedScanArtifacts', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-scan-art-list-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('reports available vs missing artifacts with sizes', () => {
    writeScan(runDir, 'scan/commands.json', '{"commands":{}}');
    const list = listAllowedScanArtifacts(runDir);
    const commands = list.find((a) => a.key === 'commands');
    const symbols = list.find((a) => a.key === 'symbols');
    expect(commands?.available).toBe(true);
    expect(commands?.size_bytes).toBeGreaterThan(0);
    expect(symbols?.available).toBe(false);
    expect(symbols?.size_bytes).toBeNull();
  });
});

describe('readScanArtifactJson', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-scan-art-json-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('parses an existing JSON artifact', () => {
    writeScan(runDir, 'scan/commands.json', '{"commands":{"test":[{"command":"pnpm test","source":"x"}]}}');
    const res = readScanArtifactJson(runDir, 'commands');
    expect(res.available).toBe(true);
    expect(asObj(res.value).commands).toBeTruthy();
  });

  test('returns text for the .txt artifact', () => {
    writeScan(runDir, 'scan/git_diff_stat.txt', 'a | 2 +-\n');
    const res = readScanArtifactJson(runDir, 'git_diff_stat');
    expect(res.available).toBe(true);
    expect(res.text).toContain('a | 2 +-');
    expect(res.value).toBeNull();
  });

  test('missing artifact is reported unavailable, not thrown', () => {
    const res = readScanArtifactJson(runDir, 'symbols');
    expect(res.available).toBe(false);
  });

  test('malformed JSON is reported with an error, not thrown', () => {
    writeScan(runDir, 'scan/symbols.json', '{not json');
    const res = readScanArtifactJson(runDir, 'symbols');
    expect(res.available).toBe(true);
    expect(res.value).toBeNull();
    expect(res.error).toMatch(/invalid JSON/i);
  });
});

describe('readScanArtifactChunk — continuation + security', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = makeRunDir('vibecode-scan-art-chunk-');
  });
  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('reads a small artifact in one chunk with full-file hash', () => {
    const content = '{"symbols":[]}';
    const abs = writeScan(runDir, 'scan/symbols.json', content);
    const res = readScanArtifactChunk(runDir, 'symbols', { byteOffset: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.artifact).toBe('symbols');
    expect(res.value.relativePath).toBe('scan/symbols.json');
    expect(res.value.content).toBe(content);
    expect(res.value.hasMore).toBe(false);
    expect(res.value.nextByteOffset).toBeNull();
    expect(res.value.contentSha256).toBe(sha256(fs.readFileSync(abs)));
  });

  test('chained reads reconstruct a large UTF-8 artifact exactly', () => {
    const content = 'abc日éf\u{1F600}ghi\n'.repeat(400);
    writeScan(runDir, 'scan/keyword_hits.json', content);
    let offset = 0;
    let reconstructed = '';
    for (let i = 0; i < 100_000; i += 1) {
      const res = readScanArtifactChunk(runDir, 'keyword_hits', { byteOffset: offset, maxBytes: 7 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.content).not.toContain('�');
      reconstructed += res.value.content;
      if (!res.value.hasMore) break;
      offset = res.value.nextByteOffset as number;
    }
    expect(reconstructed).toBe(content);
  });

  test('unknown scan artifact key is rejected without filesystem access', () => {
    const res = readScanArtifactChunk(runDir, 'not_a_real_key', {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('ARTIFACT_NOT_ALLOWED');
    expect(res.error.allowed).toContain('commands');
  });

  test('a traversal selector is rejected (not an allowlisted key)', () => {
    const res = readScanArtifactChunk(runDir, '../../../etc/passwd', {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('a raw scan path (not a key) is rejected', () => {
    writeScan(runDir, 'scan/commands.json', '{}');
    const res = readScanArtifactChunk(runDir, 'scan/commands.json', {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('a source file outside scan/ cannot be read through a scan key', () => {
    // Even if a same-named file exists elsewhere, only scan/<file> is reachable.
    writeScan(runDir, 'output/final_prompt.md', 'secret');
    const res = readScanArtifactChunk(runDir, 'file_inventory', {});
    // file_inventory.json was not written, so this is NOT_FOUND, never the source file.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('ARTIFACT_NOT_FOUND');
  });

  test('allowlisted-but-missing artifact returns ARTIFACT_NOT_FOUND', () => {
    const res = readScanArtifactChunk(runDir, 'tests', {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('ARTIFACT_NOT_FOUND');
  });

  test('byte offset beyond EOF is a structured range error', () => {
    writeScan(runDir, 'scan/symbols.json', 'hello');
    const res = readScanArtifactChunk(runDir, 'symbols', { byteOffset: 9999 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('BYTE_OFFSET_OUT_OF_RANGE');
  });
});

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
