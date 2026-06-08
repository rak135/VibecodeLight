import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildArtifactReadTool } from '../../../src/app/mcp/tools/artifact_read.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-1: CLI `vibecode runs artifact-read` continuation command.
 *
 * Pins the agent-facing JSON continuation path for CLI-only agents, proves it
 * stays at field-level parity with the MCP `vibecode_artifact_read` tool, and
 * guards that the legacy raw `runs show --artifact` human path is unchanged.
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
    JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 't', status: 'done', repo_root: repoRoot }, null, 2),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(runDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

/** Point `.vibecode/current` at a run id so `latest`/`current` resolve to it. */
function writeCurrentPointer(repoRoot: string, runId: string): void {
  fs.writeFileSync(
    path.join(repoRoot, '.vibecode', 'current', 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 't' }, null, 2),
    'utf8',
  );
}

async function runCli(args: string[]): Promise<{ stdout: string; logs: string[]; errors: string[]; exitCode: number }> {
  let stdout = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.exitCode = 0;
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', ...args]);
    return {
      stdout,
      logs: logSpy.mock.calls.map((call) => String(call[0])),
      errors: errorSpy.mock.calls.map((call) => String(call[0])),
      exitCode: Number(process.exitCode ?? 0),
    };
  } finally {
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  }
}

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

describe('vibecode runs artifact-read --json', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-cli-artread-');
    vi.resetModules();
  });
  afterEach(() => {
    repo.cleanup();
    vi.resetModules();
  });

  test('returns a stable success envelope with continuation fields', async () => {
    writeRun(repo.repoRoot, 'r1', { 'output/final_prompt.md': '# final\nbody\n' });
    const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'final_prompt', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    expect(cli.logs).toHaveLength(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; data: Record<string, unknown>; artifacts: unknown[]; warnings: unknown[] };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.relative_path).toBe('output/final_prompt.md');
    expect(envelope.data.byte_offset).toBe(0);
    expect(envelope.data.has_more).toBe(false);
    expect(envelope.data.next_byte_offset).toBeNull();
    expect(envelope.data.content).toBe('# final\nbody\n');
    expect(Array.isArray(envelope.artifacts)).toBe(true);
  });

  test('--byte-offset and --max-bytes drive a chunked read', async () => {
    writeRun(repo.repoRoot, 'r1', { 'output/context_pack.md': 'w'.repeat(3000) });
    const first = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'context_pack', '--max-bytes', '1000', '--repo', repo.repoRoot, '--json']);
    const firstData = (JSON.parse(first.logs[0]) as { data: Record<string, unknown> }).data;
    expect(firstData.bytes_read).toBe(1000);
    expect(firstData.has_more).toBe(true);
    expect(firstData.next_byte_offset).toBe(1000);

    const second = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'context_pack', '--byte-offset', '1000', '--max-bytes', '1000', '--repo', repo.repoRoot, '--json']);
    const secondData = (JSON.parse(second.logs[0]) as { data: Record<string, unknown> }).data;
    expect(secondData.byte_offset).toBe(1000);
    expect(secondData.bytes_read).toBe(1000);
  });

  test('CLI reconstructs a large UTF-8 artifact across chunks', async () => {
    const content = 'abc日éf\u{1F600}ghi\n'.repeat(300);
    writeRun(repo.repoRoot, 'r1', { 'flash/flash_output.md': content });
    let offset = 0;
    let reconstructed = '';
    for (let i = 0; i < 100_000; i += 1) {
      const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'flash_output', '--byte-offset', String(offset), '--max-bytes', '11', '--repo', repo.repoRoot, '--json']);
      const data = (JSON.parse(cli.logs[0]) as { data: Record<string, unknown> & { content: string; has_more: boolean; next_byte_offset: number | null } }).data;
      expect(data.content).not.toContain('�');
      reconstructed += data.content;
      if (!data.has_more) break;
      offset = data.next_byte_offset as number;
    }
    expect(reconstructed).toBe(content);
  });

  test('invalid byte-offset returns a structured INVALID_ARGUMENT envelope', async () => {
    writeRun(repo.repoRoot, 'r1', { 'output/final_prompt.md': 'hello' });
    const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'final_prompt', '--byte-offset', 'nope', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('byte-offset beyond EOF returns a structured INVALID_ARGUMENT envelope', async () => {
    writeRun(repo.repoRoot, 'r1', { 'output/final_prompt.md': 'hello' });
    const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'final_prompt', '--byte-offset', '9999', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('max-bytes over the hard cap returns a structured INVALID_ARGUMENT envelope', async () => {
    writeRun(repo.repoRoot, 'r1', { 'output/final_prompt.md': 'hello' });
    const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'final_prompt', '--max-bytes', String(64 * 1024 + 1), '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('a non-allowlisted scan artifact is rejected (no scan exposure in this batch)', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/symbols.json': '{"symbols":[]}' });
    const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'scan/symbols.json', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe('');
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('legacy raw `runs show --artifact` behavior is preserved (raw bytes, no envelope)', async () => {
    const content = '# raw prompt\nstays raw\n';
    writeRun(repo.repoRoot, 'r1', { 'output/final_prompt.md': content });
    const cli = await runCli(['runs', 'show', 'r1', '--artifact', 'final_prompt', '--repo', repo.repoRoot]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toBe(content);
    expect(cli.logs).toEqual([]);
  });
});

describe('CLI / MCP parity (artifact continuation)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  test('core continuation fields match between CLI runs artifact-read and the MCP tool', async () => {
    const repo = makeRepo('vibecode-parity-artread-');
    try {
      const content = 'parity日body\u{1F600}\n'.repeat(200);
      writeRun(repo.repoRoot, 'r1', { 'output/context_pack.md': content });

      const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'context_pack', '--byte-offset', '13', '--max-bytes', '777', '--repo', repo.repoRoot, '--json']);
      const cliData = (JSON.parse(cli.logs[0]) as { data: Record<string, unknown> }).data;

      const tool = buildArtifactReadTool();
      const mcp = await tool.handler({
        context: ctx(repo.repoRoot),
        arguments: { run_id: 'r1', artifact: 'context_pack', byte_offset: 13, max_bytes: 777 },
        requestId: null,
      });
      const mcpData = mcp.structuredContent.data as Record<string, unknown>;

      for (const field of [
        'run_id',
        'artifact',
        'relative_path',
        'byte_offset',
        'requested_max_bytes',
        'bytes_read',
        'total_bytes',
        'has_more',
        'next_byte_offset',
        'content_sha256',
        'content',
      ]) {
        expect(cliData[field]).toEqual(mcpData[field]);
      }
      // Spot-check the hash is genuinely the full-file hash on both surfaces.
      expect(cliData.content_sha256).toBe(createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'));
    } finally {
      repo.cleanup();
    }
  });
});

describe('vibecode runs artifact-read run selector (current/latest/explicit)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-cli-artread-sel-');
    vi.resetModules();
  });
  afterEach(() => {
    repo.cleanup();
    vi.resetModules();
  });

  test('--run current resolves the current pointer (parity with MCP run_id "current")', async () => {
    writeRun(repo.repoRoot, 'rcur', { 'output/final_prompt.md': '# current run\nbody\n' });
    writeCurrentPointer(repo.repoRoot, 'rcur');
    const cli = await runCli(['runs', 'artifact-read', '--run', 'current', '--artifact', 'final_prompt', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.run_id).toBe('rcur');
    expect(envelope.data.content).toBe('# current run\nbody\n');
  });

  test('--run latest resolves the current pointer (unchanged)', async () => {
    writeRun(repo.repoRoot, 'rcur', { 'output/final_prompt.md': '# latest run\n' });
    writeCurrentPointer(repo.repoRoot, 'rcur');
    const cli = await runCli(['runs', 'artifact-read', '--run', 'latest', '--artifact', 'final_prompt', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.run_id).toBe('rcur');
  });

  test('--run current and --run latest resolve to the same run', async () => {
    writeRun(repo.repoRoot, 'rcur', { 'output/final_prompt.md': '# same\n' });
    writeRun(repo.repoRoot, 'rold', { 'output/final_prompt.md': '# old\n' });
    writeCurrentPointer(repo.repoRoot, 'rcur');
    const cur = await runCli(['runs', 'artifact-read', '--run', 'current', '--artifact', 'final_prompt', '--repo', repo.repoRoot, '--json']);
    const latest = await runCli(['runs', 'artifact-read', '--run', 'latest', '--artifact', 'final_prompt', '--repo', repo.repoRoot, '--json']);
    const curData = (JSON.parse(cur.logs[0]) as { data: Record<string, unknown> }).data;
    const latestData = (JSON.parse(latest.logs[0]) as { data: Record<string, unknown> }).data;
    expect(curData.run_id).toBe('rcur');
    expect(latestData.run_id).toBe('rcur');
    expect(curData.run_id).toBe(latestData.run_id);
  });

  test('--run <explicit-id> still resolves the explicit run, not the current pointer', async () => {
    writeRun(repo.repoRoot, 'r1', { 'output/final_prompt.md': '# explicit\n' });
    writeRun(repo.repoRoot, 'rcur', { 'output/final_prompt.md': '# current\n' });
    writeCurrentPointer(repo.repoRoot, 'rcur');
    const cli = await runCli(['runs', 'artifact-read', '--run', 'r1', '--artifact', 'final_prompt', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.data.run_id).toBe('r1');
    expect(envelope.data.content).toBe('# explicit\n');
  });

  test('CLI --run current matches MCP run_id "current" on key fields', async () => {
    const content = 'parity日body\u{1F600}\n'.repeat(80);
    writeRun(repo.repoRoot, 'rcur', { 'output/context_pack.md': content });
    writeCurrentPointer(repo.repoRoot, 'rcur');

    const cli = await runCli(['runs', 'artifact-read', '--run', 'current', '--artifact', 'context_pack', '--byte-offset', '7', '--max-bytes', '321', '--repo', repo.repoRoot, '--json']);
    const cliData = (JSON.parse(cli.logs[0]) as { data: Record<string, unknown> }).data;

    const tool = buildArtifactReadTool();
    const mcp = await tool.handler({
      context: ctx(repo.repoRoot),
      arguments: { run_id: 'current', artifact: 'context_pack', byte_offset: 7, max_bytes: 321 },
      requestId: null,
    });
    const mcpData = mcp.structuredContent.data as Record<string, unknown>;

    for (const field of [
      'run_id',
      'artifact',
      'relative_path',
      'byte_offset',
      'requested_max_bytes',
      'bytes_read',
      'total_bytes',
      'has_more',
      'next_byte_offset',
      'content_sha256',
      'content',
    ]) {
      expect(cliData[field]).toEqual(mcpData[field]);
    }
  });
});
