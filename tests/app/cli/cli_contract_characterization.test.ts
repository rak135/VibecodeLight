import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Command } from 'commander';

const CODEGRAPH_QUERY_ADAPTER_PATH = '../../../src/adapters/codegraph/codegraph_query_commands.js';

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
    vi.doUnmock(CODEGRAPH_QUERY_ADAPTER_PATH);
    vi.resetModules();
  });

  test('current debug/internal behavior: `vibecode run create` prints a bare run_id and has no --json envelope', async () => {
    const { createCli } = await import('../../../src/app/cli/index.js');
    const program = createCli();
    const createCommand = findCommand(program, ['run', 'create']);
    expect(createCommand).toBeDefined();
    // Documented gap: unlike `runs list` / `runs show`, `run create` exposes no
    // --json flag and emits the run id as plain text. Future cleanup may add a
    // canonical envelope here.
    expect(hasJsonOption(createCommand as Command)).toBe(false);

    const { repoRoot, cleanup } = makeRepo('vibecode-cli-run-create-');
    const priorCwd = process.cwd();
    try {
      process.chdir(repoRoot);
      const cli = await runCli(['run', 'create', 'debug task']);

      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toBe('');
      expect(cli.errors).toEqual([]);
      expect(cli.logs).toHaveLength(1);
      expect(cli.logs[0]).toMatch(/^\d{8}-\d{6}-[A-Z0-9]{4}$/);
      expect(cli.logs[0].trim().startsWith('{')).toBe(false);
    } finally {
      process.chdir(priorCwd);
      cleanup();
    }
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

  test('current fallback behavior: `vibecode init --json` returns a canonical data envelope', async () => {
    const { createCli } = await import('../../../src/app/cli/index.js');
    const program = createCli();
    const initCommand = findCommand(program, ['init']);
    expect(initCommand).toBeDefined();
    expect(hasJsonOption(initCommand as Command)).toBe(true);

    const { repoRoot, cleanup } = makeRepo('vibecode-cli-init-json-');
    try {
      const cli = await runCli(['init', '--repo', repoRoot, '--json']);

      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toBe('');
      expect(cli.errors).toEqual([]);
      expect(cli.logs).toHaveLength(1);
      const payload = JSON.parse(cli.logs[0]) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        data: {
          created: expect.any(Array),
          existing: expect.any(Array),
        },
        artifacts: expect.any(Array),
        warnings: [],
      });
      expect(payload).not.toHaveProperty('created');
      expect(payload).not.toHaveProperty('existing');
    } finally {
      cleanup();
    }
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

  test('current exception: `codegraph search --json` returns special query JSON, not a canonical data envelope', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-cli-codegraph-query-json-');
    try {
      const runCodeGraphSearch = vi.fn().mockReturnValue({
        ok: true,
        command: ['codegraph', 'query', '--path', repoRoot, 'Widget', '--json'],
        repoRoot,
        stdoutText: '[{"node":{"name":"Widget"}}]',
        parsedJson: [{ node: { name: 'Widget' }, score: 12.5 }],
        warnings: ['QUERY_WARNING: bounded fixture'],
      });

      vi.doMock(CODEGRAPH_QUERY_ADAPTER_PATH, async () => {
        const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_query_commands.js')>(
          CODEGRAPH_QUERY_ADAPTER_PATH,
        );
        return { ...actual, runCodeGraphSearch };
      });

      const cli = await runCli(['codegraph', 'search', 'Widget', '--repo', repoRoot, '--json']);

      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toBe('');
      expect(cli.errors).toEqual([]);
      expect(cli.logs).toHaveLength(1);
      const payload = JSON.parse(cli.logs[0]) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: expect.any(Array),
        repoRoot,
        query: 'Widget',
        stdoutText: '[{"node":{"name":"Widget"}}]',
        parsedJson: [{ node: { name: 'Widget' }, score: 12.5 }],
        warnings: ['QUERY_WARNING: bounded fixture'],
      });
      expect(payload).not.toHaveProperty('data');
      expect(payload).not.toHaveProperty('artifacts');
    } finally {
      cleanup();
    }
  });

  test('current protocol exception: docs pin `mcp serve` stdout as the MCP JSON-RPC stream', () => {
    const docs = fs.readFileSync(
      path.resolve(__dirname, '../../../docs/ARCHITECTURE_DECISIONS.md'),
      'utf8',
    );

    expect(docs).toContain('`vibecode mcp serve` owns stdout as the MCP JSON-RPC stream');
    expect(docs).toContain('Human diagnostics');
    expect(docs).toContain('stderr');
  });

  test('current setup/admin exception: `mcp config --agent codex --json` returns stable tool-specific JSON', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-cli-mcp-config-json-');
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-contract-codex-'));
    const priorCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = codexHome;
      const cli = await runCli(['mcp', 'config', '--agent', 'codex', '--repo', repoRoot, '--json']);

      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toBe('');
      expect(cli.errors).toEqual([]);
      expect(cli.logs).toHaveLength(1);
      const payload = JSON.parse(cli.logs[0]) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        agent: 'codex',
        scope: 'user',
        server_name: 'vibecode',
        command: 'node',
      });
      expect(payload).toHaveProperty('config_path');
      expect(payload).toHaveProperty('enabled_tools');
      expect(payload).toHaveProperty('toml_snippet');
      expect(payload).not.toHaveProperty('data');
      expect(payload).not.toHaveProperty('artifacts');
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
      cleanup();
    }
  });
});
