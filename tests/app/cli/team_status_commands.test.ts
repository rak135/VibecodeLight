import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';
import type { TeamStatusOverview } from '../../../src/core/agent_session/team_status.js';

/**
 * Phase 4C — `vibecode team status` CLI contract.
 *
 * What breaks if removed:
 *   - the CLI could lose parity with the MCP tool (same core service, same
 *     overview shape, canonical JSON envelope);
 *   - invalid --max-agents or --max-items could stop being rejected;
 *   - team status could silently start mutating state (it must stay read-only).
 */

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

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

interface SuccessEnvelope { ok: true; data: TeamStatusOverview; artifacts: unknown[]; warnings: string[] }
interface ErrorEnvelope { ok: false; error: { code: string; message: string } }

describe('vibecode team status (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-team-cli-')));
  afterEach(() => repo.cleanup());

  async function register(agentMode = 'build', task = 'test'): Promise<string> {
    const res = await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', agentMode, '--task', task, '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as { data: { current_agent: { agent_id: string } } };
    return env.data.current_agent.agent_id;
  }

  test('--json returns the canonical envelope with a team status overview', async () => {
    await register();
    const res = await runCli(['team', 'status', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.summary.agents_total).toBe(1);
    expect(env.data.summary.agents_active).toBe(1);
    expect(env.data.agents).toHaveLength(1);
    expect(env.data.agents[0].recommended_action).toBeDefined();
    expect(Array.isArray(env.artifacts)).toBe(true);
  });

  test('no agents → empty overview, not an error', async () => {
    const res = await runCli(['team', 'status', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.summary.agents_total).toBe(0);
    expect(env.data.agents).toEqual([]);
  });

  test('multiple agents → all visible in overview', async () => {
    await register('build', 'work 1');
    await register('build', 'work 2');
    const res = await runCli(['team', 'status', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.data.summary.agents_total).toBe(2);
    expect(env.data.agents).toHaveLength(2);
  });

  test('invalid --max-agents is rejected with INVALID_ARGUMENT', async () => {
    for (const value of ['0', '-2', '1.5', 'ten', '51']) {
      const res = await runCli(['team', 'status', '--repo', repo.repoRoot, '--max-agents', value, '--json']);
      expect(res.exitCode).not.toBe(0);
      const env = JSON.parse(res.logs[res.logs.length - 1]) as ErrorEnvelope;
      expect(env.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('invalid --max-items is rejected with INVALID_ARGUMENT', async () => {
    for (const value of ['0', '-2', '1.5', 'ten', '51']) {
      const res = await runCli(['team', 'status', '--repo', repo.repoRoot, '--max-items', value, '--json']);
      expect(res.exitCode).not.toBe(0);
      const env = JSON.parse(res.logs[res.logs.length - 1]) as ErrorEnvelope;
      expect(env.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('human output is compact and includes the team summary', async () => {
    await register();
    const res = await runCli(['team', 'status', '--repo', repo.repoRoot]);
    expect(res.exitCode).toBe(0);
    const out = res.logs.join('\n');
    expect(out).toContain('Team:');
    expect(out).toContain('active');
    expect(out).toContain('Agents:');
    // Compact: no JSON dump in human mode.
    expect(out).not.toContain('"agents_total"');
  });

  test('team status does not mutate the git working tree', async () => {
    await register();
    const before = git(['status', '--porcelain'], repo.repoRoot).stdout;
    await runCli(['team', 'status', '--repo', repo.repoRoot, '--json']);
    expect(git(['status', '--porcelain'], repo.repoRoot).stdout).toBe(before);
  });

  test('team status leaves the coordination state file byte-identical (no heartbeat/revive)', async () => {
    await register();
    const statePath = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const before = fs.readFileSync(statePath);
    await runCli(['team', 'status', '--repo', repo.repoRoot, '--json']);
    expect(fs.readFileSync(statePath).equals(before)).toBe(true);
  });

  test('human output contains no assignment or ownership-transfer wording', async () => {
    await register();
    const res = await runCli(['team', 'status', '--repo', repo.repoRoot]);
    expect(res.exitCode).toBe(0);
    const out = res.logs.join('\n');
    expect(out).not.toMatch(/should take|assigned to|transfer ownership|take over/i);
  });
});
