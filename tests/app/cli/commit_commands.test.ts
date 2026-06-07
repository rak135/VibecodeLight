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

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string, opts: { gitignoreVibecode?: boolean } = {}): string {
  const ignore = opts.gitignoreVibecode !== false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  if (ignore) {
    fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
    git(['add', '.gitignore'], repo);
  }
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
    commit_hash: string | null;
    staged_files: string[];
    committed_files: string[];
    blocks: Array<{ code: string }>;
  };
  artifacts?: unknown[];
  warnings?: unknown[];
  error?: { code: string; message: string };
}

describe('vibecode commit guard (CLI)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  test('--dry-run reports would-stage files without committing', async () => {
    const repo = makeRepo('vibecode-cli-cg-dry-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    const before = git(['rev-parse', 'HEAD'], repo).stdout.trim();

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--dry-run', '--repo', repo, '--json']);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('dry_run');
    expect(env.data?.staged_files).toEqual(['src/a.ts']);
    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(before);
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('');
  });

  test('--dry-run with --run does not write commit_guard.json', async () => {
    const repo = makeRepo('vibecode-cli-cg-dry-run-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    writeAgentBinding(path.join(getWorkspacePaths(repo).runs, 'run1'), {
      agent_id: agent.agent_id,
      terminal_session_id: null,
      agent_mode: 'cli',
      coordination_enabled: true,
    });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = await runCli(['commit', 'guard', '--run', 'run1', '--dry-run', '--repo', repo, '--json']);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('dry_run');
    expect(fs.existsSync(path.join(getWorkspacePaths(repo).runs, 'run1', 'coordination', 'commit_guard.json'))).toBe(false);
  });

  test('commits a claimed file and returns a stable envelope', async () => {
    const repo = makeRepo('vibecode-cli-cg-commit-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--repo', repo, '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toHaveLength(1);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(Object.keys(env).sort()).toEqual(['artifacts', 'data', 'ok', 'warnings']);
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('committed');
    expect(env.data?.committed_files).toEqual(['src/a.ts']);
    expect(env.data?.commit_hash).toMatch(/^[0-9a-f]{40}$/);
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['src/a.ts']);
  });

  test('blocks an unclaimed changed file', async () => {
    const repo = makeRepo('vibecode-cli-cg-unclaimed-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    write(repo, 'src/a.ts');
    const before = git(['rev-parse', 'HEAD'], repo).stdout.trim();

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--repo', repo, '--json']);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('blocked');
    expect(env.data?.blocks.map((b) => b.code)).toContain('FINALIZE_CHECK_BLOCKED');
    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(before);
  });

  test('blocks a pre-existing unrelated staged file with GIT_INDEX_NOT_CLEAN', async () => {
    const repo = makeRepo('vibecode-cli-cg-index-', { gitignoreVibecode: false });
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    write(repo, '.vibecode/stray.txt');
    git(['add', '--', '.vibecode/stray.txt'], repo);

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--repo', repo, '--json']);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('blocked');
    expect(env.data?.blocks.map((b) => b.code)).toContain('GIT_INDEX_NOT_CLEAN');
  });

  test('rejects traversal --run without writing outside artifact', async () => {
    const repo = makeRepo('vibecode-cli-cg-badrun-');
    const outside = path.resolve(getWorkspacePaths(repo).runs, '../../outside');

    const result = await runCli(['commit', 'guard', '--run', '../../outside', '--repo', repo, '--json']);

    expect(result.exitCode).toBe(1);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_RUN_ID');
    expect(fs.existsSync(outside)).toBe(false);
  });

  test('rejects a whitespace-only message as a structured invocation error', async () => {
    const repo = makeRepo('vibecode-cli-cg-badmsg-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--message', '   ', '--repo', repo, '--json']);
    expect(result.exitCode).toBe(1);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_COMMIT_MESSAGE');
  });

  test('neither --agent nor --run is an invocation error', async () => {
    const repo = makeRepo('vibecode-cli-cg-neither-');
    const result = await runCli(['commit', 'guard', '--repo', repo, '--json']);
    expect(result.exitCode).toBe(1);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
  });
});
