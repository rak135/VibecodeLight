import fs from 'fs';
import os from 'os';
import path from 'path';

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

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

interface SuccessEnvelope { ok: true; data: Record<string, unknown>; artifacts: unknown[]; warnings: unknown[]; }
interface ErrorEnvelope { ok: false; error: { code: string; message: string; path: string; details: string[] }; }

describe('vibecode claims plan / add-bulk (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-bulk-cli-')));
  afterEach(() => repo.cleanup());

  async function register(name = 'A', mode = 'build'): Promise<string> {
    const res = await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', mode, '--task', 'test', '--name', name, '--type', 'codex', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    return (env.data as { current_agent: { agent_id: string } }).current_agent.agent_id;
  }

  test('claims plan --path a --path b --json returns a canonical envelope', async () => {
    const agent = await register();
    const res = await runCli([
      'claims', 'plan', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'add alpha', '--path', 'src/a.ts', '--path', 'tests/a.test.ts', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.artifacts).toEqual([]);
    const data = env.data as { can_claim_all: boolean; claimable_paths: string[] };
    expect(data.can_claim_all).toBe(true);
    expect(data.claimable_paths).toEqual(['src/a.ts', 'tests/a.test.ts']);
  });

  test('claims add-bulk --intent --path a --path b creates claims + intent', async () => {
    const agent = await register();
    const res = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'add alpha feature', '--path', 'src/alpha.ts', '--path', 'tests/alpha.test.ts', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    const data = env.data as { status: string; intent_id: string; created_claims: Array<{ path: string }> };
    expect(data.status).toBe('ok');
    expect(data.intent_id).toMatch(/^intent-/);
    expect(data.created_claims.map((c) => c.path)).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
  });

  test('--intent-id extends the same work intent', async () => {
    const agent = await register();
    const first = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'add alpha', '--path', 'src/alpha.ts', '--json',
    ]);
    const intentId = (JSON.parse(first.logs[0]) as SuccessEnvelope).data.intent_id as string;

    const res = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent-id', intentId, '--path', 'package-lock.json', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as { intent_id: string; created_claims: Array<{ path: string }> };
    expect(data.intent_id).toBe(intentId);
    expect(data.created_claims.map((c) => c.path)).toEqual(['package-lock.json']);
  });

  test('missing intent (no --intent / --intent-id) returns a structured error', async () => {
    const agent = await register();
    const res = await runCli(['claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--path', 'src/a.ts', '--json']);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('INVALID_INTENT');
  });

  test('empty/whitespace intent returns a structured error', async () => {
    const agent = await register();
    const res = await runCli(['claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', '   ', '--path', 'src/a.ts', '--json']);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('INVALID_INTENT');
  });

  test('missing paths returns a structured error', async () => {
    const agent = await register();
    const res = await runCli(['claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'x', '--json']);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('MISSING_REQUIRED_OPTION');
  });

  test('read_only agents are blocked from add-bulk', async () => {
    const agent = await register('RO', 'read_only');
    const res = await runCli(['claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'x', '--path', 'src/a.ts', '--json']);
    expect(res.exitCode).toBe(1);
    expect((JSON.parse(res.logs[0]) as ErrorEnvelope).error.code).toBe('READ_ONLY_AGENT');
  });

  test('conflict blocks atomically (ok:true, status=blocked, no claims created)', async () => {
    const a = await register('A');
    const b = await register('B');
    await runCli(['claims', 'add', '--repo', repo.repoRoot, '--agent', b, '--path', 'src/beta.ts', '--mode', 'exclusive', '--json']);

    const res = await runCli([
      'claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', a, '--intent', 'add alpha', '--path', 'src/alpha.ts', '--path', 'src/beta.ts', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const data = (JSON.parse(res.logs[0]) as SuccessEnvelope).data as {
      status: string;
      created_claims: unknown[];
      blocked_paths: Array<{ path: string; reason: string }>;
      conflict_id: string | null;
    };
    expect(data.status).toBe('blocked');
    expect(data.created_claims).toEqual([]);
    expect(data.blocked_paths.map((p) => p.path)).toEqual(['src/beta.ts']);
    expect(data.conflict_id).toMatch(/^conflict-/);
  });
});
