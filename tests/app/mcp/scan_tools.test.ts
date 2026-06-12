import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildScanSummaryTool } from '../../../src/app/mcp/tools/scan_summary.js';
import { buildScanArtifactReadTool } from '../../../src/app/mcp/tools/scan_artifact_read.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-2: MCP scan_summary + scan_artifact_read.
 *
 * Pins the agent-facing MCP envelope for both tools: structured summary with
 * available/missing artifacts and bounded sections; graceful missing-scan
 * behavior; continuation reads that reconstruct exactly; and rejection of
 * unknown sections/artifacts, bad offsets, and unknown argument keys.
 */

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(repoRoot, '.vibecode', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.vibecode', 'current'), { recursive: true });
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function writeRun(repoRoot: string, runId: string, files: Record<string, string>): void {
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 't', status: 'done', repo_root: repoRoot }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(runDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function pointCurrent(repoRoot: string, runId: string): void {
  fs.writeFileSync(
    path.join(repoRoot, '.vibecode', 'current', 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 't' }),
    'utf8',
  );
}

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

const SCAN_FILES: Record<string, string> = {
  'scan/commands.json': JSON.stringify({ commands: { test: [{ command: 'pnpm test', source: 'package.json' }] } }),
  'scan/file_inventory.json': JSON.stringify([{ path: 'src/a.ts' }, { path: 'src/b.ts' }]),
  'scan/symbols.json': JSON.stringify({ symbols: [{ path: 'src/a.ts', name: 'foo', kind: 'function', line: 1 }] }),
};

describe('vibecode_scan_summary', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-mcp-scan-sum-');
  });
  afterEach(() => repo.cleanup());

  test('returns a structured summary for the current run', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    pointCurrent(repo.repoRoot, 'r1');
    const tool = buildScanSummaryTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: {}, requestId: null });
    expect(res.isError).toBe(false);
    const data = res.structuredContent.data as Record<string, unknown>;
    expect(data.run_id).toBe('r1');
    expect(data.scan_available).toBe(true);
    expect(data.available_artifacts).toContain('commands');
    expect((data.recommended_next_tools as string[])).toContain('vibecode_artifact_read');
  });

  test('sections filter limits the returned sections', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const tool = buildScanSummaryTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', sections: ['commands'] }, requestId: null });
    const data = res.structuredContent.data as { sections: Record<string, unknown>; sections_requested: string[] };
    expect(data.sections_requested).toEqual(['commands']);
    expect(Object.keys(data.sections)).toEqual(['commands']);
  });

  test('missing scan dir returns ok with scan_available=false', async () => {
    writeRun(repo.repoRoot, 'r1', { 'run_manifest.json': '{}' });
    const tool = buildScanSummaryTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1' }, requestId: null });
    expect(res.isError).toBe(false);
    const data = res.structuredContent.data as Record<string, unknown>;
    expect(data.scan_available).toBe(false);
    expect((data.recommended_next_tools as string[])).toContain('vibecode_session_start');
  });

  test('unknown section is rejected with INVALID_ARGUMENT', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const tool = buildScanSummaryTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', sections: ['nope'] }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('max_items over the hard cap is rejected', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const tool = buildScanSummaryTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', max_items: 9999 }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('unknown argument key is rejected', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const tool = buildScanSummaryTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', nope: 1 }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('vibecode_scan_artifact_read', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-mcp-scan-read-');
  });
  afterEach(() => repo.cleanup());

  test('returns continuation fields for a small artifact', async () => {
    const content = '{"commands":{"test":[]}}';
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': content });
    const tool = buildScanArtifactReadTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'commands' }, requestId: null });
    expect(res.isError).toBe(false);
    const data = res.structuredContent.data as Record<string, unknown>;
    expect(data.artifact).toBe('commands');
    expect(data.relative_path).toBe('scan/commands.json');
    expect(data.content).toBe(content);
    expect(data.has_more).toBe(false);
    expect(data.next_byte_offset).toBeNull();
    expect(data.content_sha256).toBe(createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'));
  });

  test('chained reads reconstruct a large UTF-8 artifact exactly', async () => {
    const content = 'abc日éf\u{1F600}ghi\n'.repeat(300);
    writeRun(repo.repoRoot, 'r1', { 'scan/keyword_hits.json': content });
    const tool = buildScanArtifactReadTool();
    let offset = 0;
    let reconstructed = '';
    for (let i = 0; i < 100_000; i += 1) {
      const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'keyword_hits', byte_offset: offset, max_bytes: 11 }, requestId: null });
      const data = res.structuredContent.data as { content: string; has_more: boolean; next_byte_offset: number | null };
      expect(data.content).not.toContain('�');
      reconstructed += data.content;
      if (!data.has_more) break;
      offset = data.next_byte_offset as number;
    }
    expect(reconstructed).toBe(content);
  });

  test('unknown artifact key is rejected with ARTIFACT_NOT_ALLOWED', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const tool = buildScanArtifactReadTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'not_a_key' }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('a raw scan path (not a key) is rejected', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const tool = buildScanArtifactReadTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'scan/commands.json' }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('invalid byte_offset is rejected with INVALID_ARGUMENT', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': 'hello' });
    const tool = buildScanArtifactReadTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'commands', byte_offset: 9999 }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('unknown argument key is rejected', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const tool = buildScanArtifactReadTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'commands', nope: 1 }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });

  test('allowlisted-but-missing artifact returns ARTIFACT_NOT_FOUND', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const tool = buildScanArtifactReadTool();
    const res = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'symbols' }, requestId: null });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error?.code).toBe('ARTIFACT_NOT_FOUND');
  });
});
