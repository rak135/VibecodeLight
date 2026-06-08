import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';

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

interface SuccessEnvelope {
  ok: true;
  data: Record<string, unknown>;
  artifacts: unknown[];
  warnings: unknown[];
}

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; path: string; details: string[] };
}

describe('vibecode claims reap (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-reap-cli-');
  });

  afterEach(() => repo.cleanup());

  test('claims reap --dry-run --json reports stale claims without releasing', async () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    // Use a mock clock by manipulating the process — but since reapStaleClaims uses Date.now(),
    // we'll just call the CLI and let it compute. The agent is already stale because registration was long ago.
    const res = await runCli(['claims', 'reap', '--repo', repo.repoRoot, '--dry-run', '--json']);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.mode).toBe('dry_run');
    expect(env.data.stale_claims).toHaveLength(1);
    expect(env.data.reaped_claims).toHaveLength(0);
  });

  test('claims reap --json releases stale claims', async () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    addFileClaim(
      repo.repoRoot,
      { agent_id: 'agent-1', path: 'src/app.ts', mode: 'exclusive' },
      { now: '2026-06-06T00:00:30.000Z', claimId: 'claim-1' },
    );

    const res = await runCli(['claims', 'reap', '--repo', repo.repoRoot, '--json']);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.mode).toBe('apply');
    expect(env.data.reaped_claims).toHaveLength(1);
  });
});

describe('vibecode conflicts (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-conflicts-cli-');
  });

  afterEach(() => repo.cleanup());

  async function registerAgentCli(name = 'A'): Promise<string> {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', name, '--type', 'codex',
      '--agent-mode', 'build', '--task', 'test task', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    return (env.data.agent as { agent_id: string }).agent_id;
  }

  test('conflicts list --json returns empty list initially', async () => {
    const res = await runCli(['conflicts', 'list', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.conflicts).toEqual([]);
  });

  test('conflict resolution records and resolves a conflict', async () => {
    const { recordConflict } = await import('../../../src/core/coordination/conflicts.js');
    const agentId = await registerAgentCli();

    recordConflict(repo.repoRoot, {
      conflict_type: 'claim_denied',
      detected_at: '2026-06-06T00:01:00.000Z',
      involved_claims: ['claim-1'],
      involved_agents: [agentId],
      involved_files: ['src/app.ts'],
      severity: 'medium',
      description: 'denied',
      evidence: { detector: 'claim_manager', details: {} },
    }, { conflictId: 'conflict-1' });

    const listRes = await runCli(['conflicts', 'list', '--repo', repo.repoRoot, '--json']);
    expect(listRes.exitCode).toBe(0);
    const listEnv = JSON.parse(listRes.logs[0]) as SuccessEnvelope;
    expect((listEnv.data.conflicts as unknown[])).toHaveLength(1);

    const resolveRes = await runCli(['conflicts', 'resolve', '--repo', repo.repoRoot, '--conflict', 'conflict-1', '--json']);
    expect(resolveRes.exitCode).toBe(0);
    const resolveEnv = JSON.parse(resolveRes.logs[0]) as SuccessEnvelope;
    expect((resolveEnv.data.conflict as { status: string }).status).toBe('resolved');
  });

  test('conflicts resolve --json without --conflict returns JSON envelope', async () => {
    const res = await runCli(['conflicts', 'resolve', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
  });
});

describe('Commander --json error-envelope hardening', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-json-env-');
  });

  afterEach(() => repo.cleanup());

  test('claims release --json without --claim returns JSON envelope', async () => {
    const res = await runCli(['claims', 'release', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(1);
    expect(res.logs).toHaveLength(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
    expect(env.error.message).toContain('--claim');
  });

  test('claims add --json without --agent returns JSON envelope', async () => {
    const res = await runCli(['claims', 'add', '--repo', repo.repoRoot, '--path', 'src/a.ts', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
    expect(env.error.message).toContain('--agent');
  });

  test('claims add --json without --path returns JSON envelope', async () => {
    const res = await runCli(['claims', 'add', '--repo', repo.repoRoot, '--agent', 'agent-1', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
    expect(env.error.message).toContain('--path');
  });

  test('agents register --json without --name returns JSON envelope', async () => {
    const res = await runCli(['agents', 'register', '--repo', repo.repoRoot, '--type', 'codex', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
    expect(env.error.message).toContain('--name');
  });

  test('agents heartbeat --json without --agent returns JSON envelope', async () => {
    const res = await runCli(['agents', 'heartbeat', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
    expect(env.error.message).toContain('--agent');
  });

  test('text mode still shows human-readable error', async () => {
    const res = await runCli(['claims', 'release', '--repo', repo.repoRoot]);
    expect(res.exitCode).toBe(1);
    expect(res.errors.join('\n')).toContain('--claim');
  });
});
