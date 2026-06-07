import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { writeAgentBinding } from '../../../src/core/coordination/agent_binding.js';
import { getWorkspacePaths } from '../../../src/core/workspace/paths.js';

interface CliRun {
  logs: string[];
  errors: string[];
  exitCode: number;
}

async function runCli(args: string[]): Promise<CliRun> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.exitCode = 0;
    const { createCli } = await import('../../../src/app/cli/index.js');
    await createCli().parseAsync(['node', 'vibecode', ...args]);
    return {
      logs: logSpy.mock.calls.map((call) => String(call[0])),
      errors: errorSpy.mock.calls.map((call) => String(call[0])),
      exitCode: Number(process.exitCode ?? 0),
    };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  }
}

function git(gitArgs: string[], cwd: string) {
  return spawnSync('git', gitArgs, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repo);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  return repo;
}

function write(repo: string, rel: string): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x\n', 'utf8');
}

interface Envelope {
  ok: boolean;
  data?: {
    status: string;
    blocks: Array<{ code: string; path?: string }>;
    warnings: unknown[];
    changed_files: Array<{ path: string; classification: string }>;
    agent: { agent_id: string } | null;
    run_id: string | null;
    summary: Record<string, number>;
  };
  artifacts?: unknown[];
  warnings?: unknown[];
  error?: { code: string; message: string };
}

describe('vibecode finalize check (CLI)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  test('clean repo with an active agent returns a stable ok envelope', async () => {
    const repo = makeRepo('vibecode-cli-fc-clean-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });

    const result = await runCli(['finalize', 'check', '--agent', agent.agent_id, '--repo', repo, '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toHaveLength(1);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(Object.keys(env).sort()).toEqual(['artifacts', 'data', 'ok', 'warnings']);
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('ok');
    expect(env.data?.agent?.agent_id).toBe(agent.agent_id);
  });

  test('blocks an unclaimed changed file', async () => {
    const repo = makeRepo('vibecode-cli-fc-unclaimed-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    write(repo, 'src/a.ts');

    const result = await runCli(['finalize', 'check', '--agent', agent.agent_id, '--repo', repo, '--json']);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('blocked');
    const block = env.data?.blocks.find((b) => b.path === 'src/a.ts');
    expect(block?.code).toBe('UNCLAIMED_CHANGED_FILE');
  });

  test('--run resolves the bound agent', async () => {
    const repo = makeRepo('vibecode-cli-fc-run-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    writeAgentBinding(path.join(getWorkspacePaths(repo).runs, 'run1'), {
      agent_id: agent.agent_id,
      terminal_session_id: null,
      agent_mode: 'mcp',
      coordination_enabled: true,
    });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = await runCli(['finalize', 'check', '--run', 'run1', '--repo', repo, '--json']);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.run_id).toBe('run1');
    expect(env.data?.agent?.agent_id).toBe(agent.agent_id);
    expect(env.data?.status).toBe('ok');
  });

  test('--agent and --run that disagree report RUN_AGENT_MISMATCH', async () => {
    const repo = makeRepo('vibecode-cli-fc-mismatch-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex' });
    writeAgentBinding(path.join(getWorkspacePaths(repo).runs, 'run1'), {
      agent_id: b.agent_id,
      terminal_session_id: null,
      agent_mode: 'mcp',
      coordination_enabled: true,
    });

    const result = await runCli(['finalize', 'check', '--agent', a.agent_id, '--run', 'run1', '--repo', repo, '--json']);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('blocked');
    expect(env.data?.blocks.map((bl) => bl.code)).toContain('RUN_AGENT_MISMATCH');
  });

  test('rejects traversal --run without reading outside runs', async () => {
    const repo = makeRepo('vibecode-cli-fc-badrun-');
    const outside = path.resolve(getWorkspacePaths(repo).runs, '../../outside');

    const result = await runCli(['finalize', 'check', '--run', '../../outside', '--repo', repo, '--json']);

    expect(result.exitCode).toBe(1);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_RUN_ID');
    expect(fs.existsSync(outside)).toBe(false);
  });

  test('missing agent is a completed blocked check (ok:true, AGENT_NOT_FOUND)', async () => {
    const repo = makeRepo('vibecode-cli-fc-missing-');
    const result = await runCli(['finalize', 'check', '--agent', 'nope', '--repo', repo, '--json']);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('blocked');
    expect(env.data?.blocks.map((bl) => bl.code)).toContain('AGENT_NOT_FOUND');
  });

  test('neither --agent nor --run is an invocation error (ok:false, exit 1)', async () => {
    const repo = makeRepo('vibecode-cli-fc-neither-');
    const result = await runCli(['finalize', 'check', '--repo', repo, '--json']);
    expect(result.exitCode).toBe(1);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
  });
});
