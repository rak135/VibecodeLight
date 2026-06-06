import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildArtifactReadTool } from '../../src/app/mcp/tools/artifact_read.js';
import type { McpServerContext } from '../../src/app/mcp/index.js';

/**
 * Shared run-artifact read parity between the MCP `vibecode_artifact_read` tool
 * and the `vibecode runs show --artifact` CLI command.
 *
 * Both surfaces read from the same allowlisted artifact surface
 * (RUN_SHOW_ARTIFACTS in src/core/runs/run_artifacts.ts). These tests pin that
 * they return identical content for an allowlisted artifact and reject a
 * non-allowlisted artifact consistently.
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
    const abs = path.join(runDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

/**
 * Drive the real CLI. The `runs show --artifact` success path writes raw bytes
 * to process.stdout.write (NOT console.log), so we capture both streams plus the
 * exit code.
 */
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
    const { createCli } = await import('../../src/app/cli/index.js');
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

describe('MCP / CLI run-artifact read parity', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('allowlisted artifact: MCP read content equals CLI runs show --artifact content', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp-cli-artifact-ok-');
    try {
      const content = '# final prompt\n\nbody line\nsecond line\n';
      writeRun(repoRoot, 'r1', { 'output/final_prompt.md': content });

      // MCP surface.
      const tool = buildArtifactReadTool();
      const mcpResult = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: 'final_prompt' },
        requestId: null,
      });
      expect(mcpResult.isError).toBe(false);
      const mcpContent = (mcpResult.structuredContent.data as { content: string }).content;

      // CLI surface (real command).
      const cli = await runCli(['runs', 'show', 'r1', '--artifact', 'final_prompt', '--repo', repoRoot]);
      expect(cli.exitCode).toBe(0);
      expect(cli.errors).toEqual([]);

      // Both read the same on-disk artifact, byte for byte.
      expect(mcpContent).toBe(content);
      expect(cli.stdout).toBe(content);
      expect(cli.stdout).toBe(mcpContent);
    } finally {
      cleanup();
    }
  });

  test('non-allowlisted artifact: both MCP and CLI reject with ARTIFACT_NOT_ALLOWED', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp-cli-artifact-deny-');
    try {
      // Plant a real file that is NOT in RUN_SHOW_ARTIFACTS.
      writeRun(repoRoot, 'r1', { 'secret.txt': 'top secret', 'output/final_prompt.md': '# fp\n' });

      // MCP surface rejects.
      const tool = buildArtifactReadTool();
      const mcpResult = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'r1', artifact: 'secret.txt' },
        requestId: null,
      });
      expect(mcpResult.isError).toBe(true);
      const mcpError = (mcpResult.structuredContent as { error?: { code?: string } }).error;
      expect(mcpError?.code).toBe('ARTIFACT_NOT_ALLOWED');

      // CLI surface rejects with the same code (via the --json envelope).
      const cli = await runCli(['runs', 'show', 'r1', '--artifact', 'secret.txt', '--json', '--repo', repoRoot]);
      expect(cli.exitCode).toBe(1);
      // No raw artifact bytes leaked to stdout.
      expect(cli.stdout).toBe('');
      const envelope = JSON.parse(cli.logs[0]) as { ok: boolean; error: { code: string } };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('ARTIFACT_NOT_ALLOWED');
    } finally {
      cleanup();
    }
  });
});
