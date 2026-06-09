import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';

async function runCli(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.exitCode = 0;
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

/**
 * Release goes through the real git adapter (no CLI runner seam), so release
 * tests run against a REAL `git init` working tree. A plain (non-git) temp dir
 * is used only for the fail-closed git-unavailable test.
 */
function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const init = spawnSync('git', ['init', '-q'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function makeNonGitDir(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function writeFile(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

interface SuccessEnvelope { ok: true; data: Record<string, unknown>; artifacts: unknown[]; warnings: unknown[]; }
interface ErrorEnvelope { ok: false; error: { code: string; message: string; path: string; details: string[] }; }

describe('vibecode claims intents list (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-list-cli-')));
  afterEach(() => repo.cleanup());

  async function register(name = 'A', mode = 'build'): Promise<string> {
    const res = await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', mode, '--task', 'test', '--name', name, '--type', 'codex', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    return (env.data as { current_agent: { agent_id: string } }).current_agent.agent_id;
  }

  test('claims intents list --json returns active intents', async () => {
    const agent = await register();
    // Create an intent via add-bulk.
    await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'work on alpha', '--path', 'src/alpha.ts', '--json',
    ]);

    const res = await runCli([
      'claims', 'intents', 'list', '--repo', repo.repoRoot, '--agent', agent, '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    const data = env.data as { intents: Array<{ intent: string; status: string; claim_count: number }> };
    expect(data.intents).toHaveLength(1);
    expect(data.intents[0].intent).toBe('work on alpha');
    expect(data.intents[0].status).toBe('active');
  });

  test('claims intents list --status all includes released', async () => {
    const agent = await register();
    const bulkRes = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'work', '--path', 'src/a.ts', '--json',
    ]);
    const intentId = (JSON.parse(bulkRes.logs[0]) as SuccessEnvelope).data.intent_id as string;

    // Release.
    await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--agent', agent, '--intent-id', intentId, '--json',
    ]);

    // List with status=all.
    const res = await runCli([
      'claims', 'intents', 'list', '--repo', repo.repoRoot, '--agent', agent, '--status', 'all', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as { intents: Array<{ status: string }> };
    expect(data.intents).toHaveLength(1);
    expect(data.intents[0].status).toBe('released');
  });

  test('claims intents list --max-items 1 caps and --status released works', async () => {
    const agent = await register();
    await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'first', '--path', 'src/a.ts', '--json',
    ]);
    await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'second', '--path', 'src/b.ts', '--json',
    ]);

    const res = await runCli([
      'claims', 'intents', 'list', '--repo', repo.repoRoot, '--agent', agent, '--max-items', '1', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as { intents: unknown[]; truncated: boolean };
    expect(data.intents).toHaveLength(1);
    expect(data.truncated).toBe(true);

    // --status released is a valid enum value (none released yet → empty).
    const released = await runCli([
      'claims', 'intents', 'list', '--repo', repo.repoRoot, '--agent', agent, '--status', 'released', '--json',
    ]);
    expect(released.exitCode).toBe(0);
    expect(((JSON.parse(released.logs[0]) as SuccessEnvelope).data as { intents: unknown[] }).intents).toHaveLength(0);
  });

  test('claims intents list rejects invalid --max-items (NaN, zero, negative)', async () => {
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const res = await runCli([
        'claims', 'intents', 'list', '--repo', repo.repoRoot, '--max-items', bad, '--json',
      ]);
      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
      expect(env.error.code).toBe('INVALID_ARGUMENT');
      expect(env.error.message).toContain('--max-items');
    }
  });

  test('claims intents list rejects invalid --status', async () => {
    const res = await runCli([
      'claims', 'intents', 'list', '--repo', repo.repoRoot, '--status', 'bogus', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.error.code).toBe('INVALID_ARGUMENT');
    expect(env.error.message).toContain('--status');
  });

  test('claims intents list --intent-id filters', async () => {
    const agent = await register();
    const first = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'first', '--path', 'src/a.ts', '--json',
    ]);
    const firstId = (JSON.parse(first.logs[0]) as SuccessEnvelope).data.intent_id as string;
    await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'second', '--path', 'src/b.ts', '--json',
    ]);

    const res = await runCli([
      'claims', 'intents', 'list', '--repo', repo.repoRoot, '--agent', agent, '--intent-id', firstId, '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as { intents: Array<{ intent: string }> };
    expect(data.intents).toHaveLength(1);
    expect(data.intents[0].intent).toBe('first');
  });
});

describe('vibecode claims intent-release (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-intent-rel-cli-')));
  afterEach(() => repo.cleanup());

  async function register(name = 'A', mode = 'build'): Promise<string> {
    const res = await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', mode, '--task', 'test', '--name', name, '--type', 'codex', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    return (env.data as { current_agent: { agent_id: string } }).current_agent.agent_id;
  }

  test('intent-release --dry-run --json returns release info', async () => {
    const agent = await register();
    const bulkRes = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'work', '--path', 'src/a.ts', '--json',
    ]);
    const intentId = (JSON.parse(bulkRes.logs[0]) as SuccessEnvelope).data.intent_id as string;

    const res = await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--agent', agent, '--intent-id', intentId, '--dry-run', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    const data = env.data as { dry_run: boolean; release_allowed: boolean; released_claims: unknown[] };
    expect(data.dry_run).toBe(true);
    expect(data.release_allowed).toBe(true);
    expect(data.released_claims).toHaveLength(1);
  });

  test('intent-release --json releases claims and intent', async () => {
    const agent = await register();
    const bulkRes = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'work', '--path', 'src/a.ts', '--json',
    ]);
    const intentId = (JSON.parse(bulkRes.logs[0]) as SuccessEnvelope).data.intent_id as string;

    const res = await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--agent', agent, '--intent-id', intentId, '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as { status: string; intent_status: string; released_claims: unknown[] };
    expect(data.status).toBe('ok');
    expect(data.intent_status).toBe('released');
    expect(data.released_claims).toHaveLength(1);
  });

  test('intent-release blocks when claimed file is dirty (real git tree)', async () => {
    const agent = await register();
    // The claimed file exists and is untracked → dirty in the working tree.
    writeFile(repo.repoRoot, 'src/a.ts');
    const bulkRes = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'work', '--path', 'src/a.ts', '--json',
    ]);
    const intentId = (JSON.parse(bulkRes.logs[0]) as SuccessEnvelope).data.intent_id as string;

    const res = await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--agent', agent, '--intent-id', intentId, '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as {
      status: string; release_allowed: boolean; blocked_reason: string | null;
      dirty_claimed_paths: string[]; released_claims: unknown[];
    };
    expect(data.status).toBe('blocked');
    expect(data.release_allowed).toBe(false);
    expect(data.blocked_reason).toBe('dirty_claimed_files');
    expect(data.dirty_claimed_paths).toEqual(['src/a.ts']);
    expect(data.released_claims).toHaveLength(0);
  });

  test('intent-release blocks fail-closed when git is unavailable', async () => {
    const nonGit = makeNonGitDir('vibecode-intent-rel-cli-nogit-');
    try {
      const reg = await runCli([
        'session', 'bootstrap', '--repo', nonGit.repoRoot, '--register', '--agent-mode', 'build', '--task', 'test', '--name', 'A', '--type', 'codex', '--json',
      ]);
      const agent = ((JSON.parse(reg.logs[0]) as SuccessEnvelope).data as { current_agent: { agent_id: string } }).current_agent.agent_id;
      const bulkRes = await runCli([
        'claims', 'add-bulk', '--repo', nonGit.repoRoot, '--agent', agent, '--intent', 'work', '--path', 'src/a.ts', '--json',
      ]);
      const intentId = (JSON.parse(bulkRes.logs[0]) as SuccessEnvelope).data.intent_id as string;

      const res = await runCli([
        'claims', 'intent-release', '--repo', nonGit.repoRoot, '--agent', agent, '--intent-id', intentId, '--json',
      ]);
      expect(res.exitCode).toBe(0);
      const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as {
        status: string; release_allowed: boolean; blocked_reason: string | null; released_claims: unknown[];
      };
      expect(data.status).toBe('blocked');
      expect(data.release_allowed).toBe(false);
      expect(data.blocked_reason).toBe('git_unavailable');
      expect(data.released_claims).toHaveLength(0);
    } finally {
      nonGit.cleanup();
    }
  });

  test('missing --agent returns structured error', async () => {
    const res = await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--intent-id', 'intent-x', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('MISSING_REQUIRED_OPTION');
  });

  test('missing --intent-id returns structured error', async () => {
    const agent = await register();
    const res = await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--agent', agent, '--json',
    ]);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('MISSING_REQUIRED_OPTION');
  });

  test('nonexistent intent returns structured error', async () => {
    const agent = await register();
    const res = await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--agent', agent, '--intent-id', 'intent-nonexistent', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('INTENT_NOT_FOUND');
  });

  test('another agent intent returns structured error', async () => {
    const agentA = await register('A');
    await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', 'build', '--task', 'test', '--name', 'B', '--type', 'codex', '--json',
    ]);
    const bulkRes = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agentA, '--intent', 'a-work', '--path', 'src/a.ts', '--json',
    ]);
    const intentId = (JSON.parse(bulkRes.logs[0]) as SuccessEnvelope).data.intent_id as string;

    const res = await runCli([
      'claims', 'intent-release', '--repo', repo.repoRoot, '--agent', 'agent-b', '--intent-id', intentId, '--json',
    ]);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('INTENT_FORBIDDEN');
  });
});
