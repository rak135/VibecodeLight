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
    skipped_files: Array<{ path: string; reason: string }>;
    isolated_commit: boolean;
    blocks: Array<{ code: string }>;
    warnings: Array<{ code: string; message: string }>;
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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

  test('Phase 3A: --dry-run allows an isolated commit with an UNCLAIMED_DIRTY_FILES_SKIPPED warning', async () => {
    const repo = makeRepo('vibecode-cli-cg-iso-dry-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'claimed/file.ts', mode: 'exclusive' });
    write(repo, 'claimed/file.ts');
    write(repo, 'unclaimed/other-wip.ts');
    const before = git(['rev-parse', 'HEAD'], repo).stdout.trim();

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--dry-run', '--repo', repo, '--json']);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('dry_run');
    expect(env.data?.isolated_commit).toBe(true);
    expect(env.data?.staged_files).toEqual(['claimed/file.ts']);
    expect(env.data?.skipped_files).toEqual([{ path: 'unclaimed/other-wip.ts', reason: 'unclaimed' }]);
    expect(env.data?.warnings.map((w) => w.code)).toContain('UNCLAIMED_DIRTY_FILES_SKIPPED');
    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(before);
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('');
  });

  test('Phase 3A: real commit succeeds and leaves the skipped unclaimed file dirty', async () => {
    const repo = makeRepo('vibecode-cli-cg-iso-commit-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'claimed/file.ts', mode: 'exclusive' });
    write(repo, 'claimed/file.ts');
    write(repo, 'unclaimed/other-wip.ts');

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--repo', repo, '--json']);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('committed');
    expect(env.data?.isolated_commit).toBe(true);
    expect(env.data?.committed_files).toEqual(['claimed/file.ts']);
    expect(env.data?.warnings.map((w) => w.code)).toContain('UNCLAIMED_DIRTY_FILES_SKIPPED');
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['claimed/file.ts']);
    expect(git(['status', '--porcelain=v1', '--untracked-files=all'], repo).stdout).toContain('unclaimed/other-wip.ts');
  });

  test('Phase 3A: a pre-staged unclaimed file blocks with STAGED_UNCLAIMED_FILES_BLOCKED', async () => {
    const repo = makeRepo('vibecode-cli-cg-iso-staged-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'claimed/file.ts', mode: 'exclusive' });
    write(repo, 'claimed/file.ts');
    write(repo, 'unclaimed/staged-wip.ts');
    git(['add', '--', 'unclaimed/staged-wip.ts'], repo);
    const before = git(['rev-parse', 'HEAD'], repo).stdout.trim();

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--repo', repo, '--json']);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('blocked');
    expect(env.data?.blocks.map((b) => b.code)).toContain('STAGED_UNCLAIMED_FILES_BLOCKED');
    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(before);
    // The guard never unstages the foreign file.
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('unclaimed/staged-wip.ts');
  });

  test('Phase 3A: non-JSON output prints the isolated-commit skip warning', async () => {
    const repo = makeRepo('vibecode-cli-cg-iso-human-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'claimed/file.ts', mode: 'exclusive' });
    write(repo, 'claimed/file.ts');
    write(repo, 'unclaimed/other-wip.ts');

    const result = await runCli(['commit', 'guard', '--agent', agent.agent_id, '--dry-run', '--repo', repo]);
    expect(result.exitCode).toBe(0);
    const output = result.logs.join('\n');
    expect(output).toContain('UNCLAIMED_DIRTY_FILES_SKIPPED');
    expect(output).toContain('unclaimed/other-wip.ts');
  });

  test('parallel non-overlapping: Agent A commits only its claimed file via CLI', async () => {
    const repo = makeRepo('vibecode-cli-cg-parallel-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/alpha.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/beta.ts', mode: 'exclusive' });
    write(repo, 'src/alpha.ts');
    write(repo, 'src/beta.ts');
    const before = git(['rev-parse', 'HEAD'], repo).stdout.trim();

    const result = await runCli(['commit', 'guard', '--agent', a.agent_id, '--repo', repo, '--json']);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.logs[0]) as Envelope;
    expect(env.ok).toBe(true);
    expect(env.data?.status).toBe('committed');
    expect(env.data?.committed_files).toEqual(['src/alpha.ts']);
    expect(env.data?.commit_hash).not.toBe(before);

    // Only src/alpha.ts in the commit
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['src/alpha.ts']);

    // src/beta.ts remains dirty
    expect(git(['status', '--porcelain=v1'], repo).stdout).toContain('src/beta.ts');
  });
});
