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

interface SuccessEnvelope {
  ok: true;
  data: Record<string, unknown>;
  artifacts: unknown[];
  warnings: unknown[];
}
interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

describe('vibecode agents (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-agents-cli-');
  });
  afterEach(() => repo.cleanup());

  async function register(name = 'Codex A', type = 'codex'): Promise<{ agent_id: string }> {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', name, '--type', type,
      '--agent-mode', 'build', '--task', 'test task', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    return env.data.agent as { agent_id: string };
  }

  test('register --json returns a stable success envelope with the created agent', async () => {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', 'Codex A', '--type', 'codex',
      '--agent-mode', 'build', '--task', 'test task', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.errors).toEqual([]);
    expect(res.logs).toHaveLength(1);

    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.artifacts).toEqual([]);
    expect(env.warnings).toEqual([]);
    const agent = env.data.agent as Record<string, unknown>;
    expect(agent.agent_name).toBe('Codex A');
    expect(agent.agent_type).toBe('codex');
    expect(agent.status).toBe('active');
    expect(typeof agent.agent_id).toBe('string');

    // State persisted under the generated coordination tree only.
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(true);
  });

  test('list --json returns registered agents', async () => {
    await register('A', 'codex');
    await register('B', 'claude');
    const res = await runCli(['agents', 'list', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    const agents = env.data.agents as Array<{ agent_name: string }>;
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.agent_name).sort()).toEqual(['A', 'B']);
  });

  test('heartbeat --agent updates the heartbeat', async () => {
    const { agent_id } = await register();
    const res = await runCli(['agents', 'heartbeat', '--repo', repo.repoRoot, '--agent', agent_id, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    const agent = env.data.agent as { agent_id: string; status: string };
    expect(agent.agent_id).toBe(agent_id);
    expect(agent.status).toBe('active');
  });

  test('status --agent returns exactly one agent', async () => {
    const { agent_id } = await register();
    const res = await runCli(['agents', 'status', '--repo', repo.repoRoot, '--agent', agent_id, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect((env.data.agent as { agent_id: string }).agent_id).toBe(agent_id);
  });

  test('invalid agent type returns a structured validation error', async () => {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', 'X', '--type', 'gpt',
      '--agent-mode', 'build', '--task', 'x', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_AGENT_TYPE');
  });

  test('missing agent returns a structured AGENT_NOT_FOUND error', async () => {
    const res = await runCli(['agents', 'status', '--repo', repo.repoRoot, '--agent', 'nope', '--json']);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('AGENT_NOT_FOUND');
  });

  test('coordination status --json now includes registered agents', async () => {
    const { agent_id } = await register();
    const res = await runCli(['coordination', 'status', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope & { data: { summary: { agents: number }; agents: unknown[] } };
    expect(env.data.summary.agents).toBe(1);
    const agents = env.data.agents as Array<{ agent_id: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0].agent_id).toBe(agent_id);
  });

  test('register without --agent-mode fails with structured error', async () => {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', 'Bot', '--type', 'codex', '--task', 'do work', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
    expect(env.error.message).toContain('--agent-mode');
  });

  test('register without --task fails with structured error', async () => {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', 'Bot', '--type', 'codex', '--agent-mode', 'build', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
    expect(env.error.message).toContain('--task');
  });

  test('register with --agent-mode and --task succeeds', async () => {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', 'Bot', '--type', 'codex',
      '--agent-mode', 'build', '--task', 'implement feature', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    const agent = env.data.agent as { metadata?: { operating_mode?: string; task?: string } };
    expect(agent.metadata?.operating_mode).toBe('build');
    expect(agent.metadata?.task).toBe('implement feature');
  });

  test('register with invalid --agent-mode fails with structured error', async () => {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', 'Bot', '--type', 'codex',
      '--agent-mode', 'observer', '--task', 'x', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('INVALID_ARGUMENT');
    expect(env.error.message).toContain('read_only');
  });

  test('register with empty --task fails with structured error', async () => {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', 'Bot', '--type', 'codex',
      '--agent-mode', 'build', '--task', '   ', '--json',
    ]);
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
  });
});
