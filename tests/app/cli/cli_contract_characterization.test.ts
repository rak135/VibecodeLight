import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Command } from 'commander';

/**
 * Characterization tests pinning CURRENT CLI behavior gaps where the MCP and CLI
 * surfaces are not yet symmetric. These tests describe reality before the
 * planned CLI envelope cleanup; they are NOT a specification of the desired
 * final behavior. Each test name says "current behavior" on purpose.
 *
 * Do not "fix" these by changing production code in this batch — the cleanup is
 * a separate, later checkpoint.
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

/** Walk the commander tree to find a nested subcommand by its path of names. */
function findCommand(program: Command, namePath: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of namePath) {
    if (!current) return undefined;
    current = current.commands.find((cmd) => cmd.name() === name);
  }
  return current;
}

function hasJsonOption(command: Command): boolean {
  return command.options.some((option) => option.long === '--json');
}

describe('CLI contract characterization (current behavior, pre-cleanup)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('current behavior: `vibecode run create` has no --json envelope (prints bare run_id)', async () => {
    const { createCli } = await import('../../../src/app/cli/index.js');
    const program = createCli();
    const createCommand = findCommand(program, ['run', 'create']);
    expect(createCommand).toBeDefined();
    // Documented gap: unlike `runs list` / `runs show`, `run create` exposes no
    // --json flag and emits the run id as plain text. Future cleanup may add a
    // canonical envelope here.
    expect(hasJsonOption(createCommand as Command)).toBe(false);
  });

  test('current behavior: `runs list` and `runs show` DO expose --json (asymmetry baseline)', async () => {
    const { createCli } = await import('../../../src/app/cli/index.js');
    const program = createCli();
    const listCommand = findCommand(program, ['runs', 'list']);
    const showCommand = findCommand(program, ['runs', 'show']);
    expect(listCommand).toBeDefined();
    expect(showCommand).toBeDefined();
    expect(hasJsonOption(listCommand as Command)).toBe(true);
    expect(hasJsonOption(showCommand as Command)).toBe(true);
  });

  test('current behavior: `runs show --artifact --json` streams RAW artifact content (no JSON envelope) on success', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-cli-artifact-json-');
    try {
      const content = '# raw final prompt\nnot wrapped in an envelope\n';
      writeRun(repoRoot, 'r1', { 'output/final_prompt.md': content });

      const cli = await runCli(['runs', 'show', 'r1', '--artifact', 'final_prompt', '--json', '--repo', repoRoot]);

      expect(cli.exitCode).toBe(0);
      // The success artifact branch ignores --json and writes raw bytes to stdout...
      expect(cli.stdout).toBe(content);
      // ...and does NOT emit a {"ok":true,...} canonical envelope via console.log.
      expect(cli.logs).toEqual([]);
      expect(cli.stdout.trim().startsWith('{')).toBe(false);
    } finally {
      cleanup();
    }
  });
});
