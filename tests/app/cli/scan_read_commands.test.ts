import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildScanArtifactReadTool } from '../../../src/app/mcp/tools/scan_artifact_read.js';
import { buildScanSummaryTool } from '../../../src/app/mcp/tools/scan_summary.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';

/**
 * Phase 1B-2: CLI `vibecode scan summary` + `vibecode scan artifact-read`.
 *
 * Pins the agent-facing CLI JSON path, proves field-level parity with the MCP
 * scan tools, validates structured errors, and guards that the legacy
 * `vibecode scan <task>` (run the scanner) form is not shadowed.
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

const SCAN_FILES: Record<string, string> = {
  'scan/commands.json': JSON.stringify({ commands: { test: [{ command: 'pnpm test', source: 'package.json' }] } }),
  'scan/file_inventory.json': JSON.stringify([{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }]),
  'scan/symbols.json': JSON.stringify({ symbols: [{ path: 'src/a.ts', name: 'foo', kind: 'function', line: 1 }] }),
};

describe('vibecode scan summary --json', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-cli-scan-sum-');
    vi.resetModules();
  });
  afterEach(() => {
    repo.cleanup();
    vi.resetModules();
  });

  test('returns a stable envelope for the current run', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    pointCurrent(repo.repoRoot, 'r1');
    const cli = await runCli(['scan', 'summary', '--run', 'current', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; data: Record<string, unknown> };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.run_id).toBe('r1');
    expect(envelope.data.scan_available).toBe(true);
    expect(envelope.data.available_artifacts).toContain('commands');
  });

  test('--sections filters the sections', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--sections', 'files,commands', '--repo', repo.repoRoot, '--json']);
    const data = (JSON.parse(cli.logs[0]) as { data: { sections_requested: string[] } }).data;
    expect(data.sections_requested).toEqual(['files', 'commands']);
  });

  test('--max-items caps and marks truncation', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--sections', 'files', '--max-items', '2', '--repo', repo.repoRoot, '--json']);
    const data = (JSON.parse(cli.logs[0]) as { data: { sections: Record<string, { returned: number; total: number; truncated: boolean }> } }).data;
    expect(data.sections.files.returned).toBe(2);
    expect(data.sections.files.total).toBe(3);
    expect(data.sections.files.truncated).toBe(true);
  });

  test('missing scan dir returns ok with scan_available=false', async () => {
    writeRun(repo.repoRoot, 'r1', {});
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const data = (JSON.parse(cli.logs[0]) as { data: { scan_available: boolean } }).data;
    expect(data.scan_available).toBe(false);
  });

  test('invalid section returns a structured error', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--sections', 'nope', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('--max-items 0 returns a structured error', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--max-items', '0', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('vibecode scan artifact-read --json', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-cli-scan-read-');
    vi.resetModules();
  });
  afterEach(() => {
    repo.cleanup();
    vi.resetModules();
  });

  test('returns continuation fields', async () => {
    const content = '{"commands":{"test":[]}}';
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': content });
    const cli = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'commands', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const data = (JSON.parse(cli.logs[0]) as { data: Record<string, unknown> }).data;
    expect(data.artifact).toBe('commands');
    expect(data.relative_path).toBe('scan/commands.json');
    expect(data.content).toBe(content);
    expect(data.has_more).toBe(false);
    expect(data.next_byte_offset).toBeNull();
  });

  test('--byte-offset / --max-bytes drive a chunked read', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/keyword_hits.json': 'w'.repeat(3000) });
    const first = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'keyword_hits', '--max-bytes', '1000', '--repo', repo.repoRoot, '--json']);
    const firstData = (JSON.parse(first.logs[0]) as { data: Record<string, unknown> }).data;
    expect(firstData.bytes_read).toBe(1000);
    expect(firstData.has_more).toBe(true);
    expect(firstData.next_byte_offset).toBe(1000);
  });

  test('chained chunks reconstruct UTF-8 content', async () => {
    const content = 'abc日éf\u{1F600}ghi\n'.repeat(200);
    writeRun(repo.repoRoot, 'r1', { 'scan/symbols.json': content });
    let offset = 0;
    let reconstructed = '';
    for (let i = 0; i < 100_000; i += 1) {
      const cli = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'symbols', '--byte-offset', String(offset), '--max-bytes', '11', '--repo', repo.repoRoot, '--json']);
      const data = (JSON.parse(cli.logs[0]) as { data: { content: string; has_more: boolean; next_byte_offset: number | null } }).data;
      expect(data.content).not.toContain('�');
      reconstructed += data.content;
      if (!data.has_more) break;
      offset = data.next_byte_offset as number;
    }
    expect(reconstructed).toBe(content);
  });

  test('invalid artifact returns a structured ARTIFACT_NOT_ALLOWED error', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const cli = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'not_a_key', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe('');
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('a raw scan path is rejected (no arbitrary path read)', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const cli = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'scan/commands.json', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.error.code).toBe('ARTIFACT_NOT_ALLOWED');
  });

  test('--run current and explicit id resolve correctly', async () => {
    writeRun(repo.repoRoot, 'rcur', { 'scan/commands.json': '{"cur":1}' });
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{"explicit":1}' });
    pointCurrent(repo.repoRoot, 'rcur');
    const cur = await runCli(['scan', 'artifact-read', '--run', 'current', '--artifact', 'commands', '--repo', repo.repoRoot, '--json']);
    const explicit = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'commands', '--repo', repo.repoRoot, '--json']);
    expect((JSON.parse(cur.logs[0]) as { data: { run_id: string } }).data.run_id).toBe('rcur');
    expect((JSON.parse(explicit.logs[0]) as { data: { run_id: string } }).data.run_id).toBe('r1');
  });

  test('CLI / MCP field parity for scan artifact read', async () => {
    const content = 'parity日body\u{1F600}\n'.repeat(120);
    writeRun(repo.repoRoot, 'r1', { 'scan/symbols.json': content });
    const cli = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'symbols', '--byte-offset', '7', '--max-bytes', '321', '--repo', repo.repoRoot, '--json']);
    const cliData = (JSON.parse(cli.logs[0]) as { data: Record<string, unknown> }).data;

    const tool = buildScanArtifactReadTool();
    const mcp = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', artifact: 'symbols', byte_offset: 7, max_bytes: 321 }, requestId: null });
    const mcpData = mcp.structuredContent.data as Record<string, unknown>;

    for (const field of ['run_id', 'artifact', 'relative_path', 'byte_offset', 'requested_max_bytes', 'bytes_read', 'total_bytes', 'has_more', 'next_byte_offset', 'content_sha256', 'content']) {
      expect(cliData[field]).toEqual(mcpData[field]);
    }
  });
});

describe('Phase 1B-2 follow-up A2: scan CLI input hardening', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-cli-scan-harden-');
    vi.resetModules();
  });
  afterEach(() => {
    repo.cleanup();
    vi.resetModules();
  });

  test('scan summary --max-items with a non-numeric string is a structured error', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--max-items', 'nope', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('scan artifact-read --byte-offset with a non-numeric string is a structured error', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const cli = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'commands', '--byte-offset', 'nope', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe('');
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('scan artifact-read --max-bytes with a non-numeric string is a structured error', async () => {
    writeRun(repo.repoRoot, 'r1', { 'scan/commands.json': '{}' });
    const cli = await runCli(['scan', 'artifact-read', '--run', 'r1', '--artifact', 'commands', '--max-bytes', 'nope', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe('');
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });

  test('scan summary --sections trims surrounding whitespace around comma-separated values', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--sections', 'files, commands, tests', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const data = (JSON.parse(cli.logs[0]) as { data: { sections_requested: string[] } }).data;
    expect(data.sections_requested).toEqual(['files', 'commands', 'tests']);
  });

  test('scan summary --sections dedupes repeated sections while preserving order', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--sections', 'files,files,commands,files', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(0);
    const data = (JSON.parse(cli.logs[0]) as { data: { sections_requested: string[]; sections: Record<string, unknown> } }).data;
    expect(data.sections_requested).toEqual(['files', 'commands']);
    expect(Object.keys(data.sections).sort()).toEqual(['commands', 'files']);
  });

  test('scan summary --sections rejects an unknown section even mixed with valid ones', async () => {
    writeRun(repo.repoRoot, 'r1', SCAN_FILES);
    const cli = await runCli(['scan', 'summary', '--run', 'r1', '--sections', 'files,bogus', '--repo', repo.repoRoot, '--json']);
    expect(cli.exitCode).toBe(1);
    const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('CLI / MCP parity (scan summary)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  test('scan summary shared fields match between CLI and MCP', async () => {
    const repo = makeRepo('vibecode-parity-scan-sum-');
    try {
      writeRun(repo.repoRoot, 'r1', SCAN_FILES);
      const cli = await runCli(['scan', 'summary', '--run', 'r1', '--sections', 'files,commands,symbols', '--repo', repo.repoRoot, '--json']);
      const cliData = (JSON.parse(cli.logs[0]) as { data: Record<string, unknown> }).data;

      const tool = buildScanSummaryTool();
      const mcp = await tool.handler({ context: ctx(repo.repoRoot), arguments: { run_id: 'r1', sections: ['files', 'commands', 'symbols'] }, requestId: null });
      const mcpData = mcp.structuredContent.data as Record<string, unknown>;

      for (const field of ['run_id', 'scan_available', 'scan_dir_available', 'sections_requested', 'available_artifacts', 'missing_artifacts', 'max_items']) {
        expect(cliData[field]).toEqual(mcpData[field]);
      }
      expect(JSON.stringify(cliData.sections)).toBe(JSON.stringify(mcpData.sections));
    } finally {
      repo.cleanup();
    }
  });
});

describe('legacy vibecode scan <task> is not shadowed', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  test('the scan command keeps its <task> argument and gains the read subcommands', async () => {
    // Introspect the command tree rather than invoking the real scanner
    // subprocess (which is environment-dependent and slow). This proves the
    // legacy positional form coexists with the new subcommands.
    const { createCli } = await import('../../../src/app/cli/index.js');
    const program = createCli();
    const scan = program.commands.find((c) => c.name() === 'scan');
    expect(scan).toBeTruthy();
    // Legacy: scan still takes a required <task> positional.
    const argNames = (scan!.registeredArguments ?? []).map((a) => a.name());
    expect(argNames).toContain('task');
    // New: scan now owns the read subcommands.
    const subNames = scan!.commands.map((c) => c.name());
    expect(subNames).toContain('summary');
    expect(subNames).toContain('artifact-read');
  });
});
