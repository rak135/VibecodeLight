import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';
import type { AgentHandoffPacket } from '../../../src/core/agent_session/handoff_packet.js';

/**
 * Phase 4A — `vibecode handoff prepare` CLI contract.
 *
 * What breaks if removed:
 *   - the CLI could lose parity with the MCP tool (same core service, same
 *     packet shape, canonical JSON envelope);
 *   - missing/invalid --agent or --max-items could stop being rejected;
 *   - prepare could silently start mutating state (it must stay read-only).
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

function write(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

interface SuccessEnvelope { ok: true; data: AgentHandoffPacket; artifacts: unknown[]; warnings: string[] }
interface ErrorEnvelope { ok: false; error: { code: string; message: string } }

describe('vibecode handoff prepare (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-handoff-cli-')));
  afterEach(() => repo.cleanup());

  async function register(): Promise<string> {
    const res = await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', 'build', '--task', 'phase 4a test', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as { data: { current_agent: { agent_id: string } } };
    return env.data.current_agent.agent_id;
  }

  test('--json returns the canonical envelope with a ready_to_handoff packet', async () => {
    const agent = await register();
    const res = await runCli(['handoff', 'prepare', '--repo', repo.repoRoot, '--agent', agent, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.agent_id).toBe(agent);
    expect(env.data.handoff.handoff_state).toBe('ready_to_handoff');
    expect(env.data.do_not_do.length).toBeGreaterThan(0);
    expect(Array.isArray(env.artifacts)).toBe(true);
  });

  test('dirty claimed file: commit_before_handoff and no mutation of the tree', async () => {
    const agent = await register();
    await runCli(['claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', agent, '--intent', 'work', '--path', 'src/mine.ts', '--json']);
    write(repo.repoRoot, 'src/mine.ts');
    const before = git(['status', '--porcelain'], repo.repoRoot).stdout;

    const res = await runCli(['handoff', 'prepare', '--repo', repo.repoRoot, '--agent', agent, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.data.handoff.handoff_state).toBe('commit_before_handoff');
    expect(env.data.handoff.handoff_ready).toBe(false);
    expect(git(['status', '--porcelain'], repo.repoRoot).stdout).toBe(before);
  });

  test('missing --agent is a structured MISSING_REQUIRED_OPTION error', async () => {
    const res = await runCli(['handoff', 'prepare', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).not.toBe(0);
    const env = JSON.parse(res.logs[res.logs.length - 1]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
  });

  test('unknown agent id yields a packet with terminated_or_missing_agent, not an error', async () => {
    const res = await runCli(['handoff', 'prepare', '--repo', repo.repoRoot, '--agent', 'agent-gone', '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.data.handoff.handoff_state).toBe('terminated_or_missing_agent');
  });

  test('invalid and over-cap --max-items are rejected with INVALID_ARGUMENT', async () => {
    for (const value of ['0', '-2', '1.5', 'ten', '51']) {
      const res = await runCli(['handoff', 'prepare', '--repo', repo.repoRoot, '--agent', 'agent-x', '--max-items', value, '--json']);
      expect(res.exitCode).not.toBe(0);
      const env = JSON.parse(res.logs[res.logs.length - 1]) as ErrorEnvelope;
      expect(env.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('human output is compact and includes the handoff summary and do_not_do', async () => {
    const agent = await register();
    const res = await runCli(['handoff', 'prepare', '--repo', repo.repoRoot, '--agent', agent]);
    expect(res.exitCode).toBe(0);
    const out = res.logs.join('\n');
    expect(out).toContain('Handoff: ready_to_handoff');
    expect(out).toContain('do_not_do:');
    expect(out).toContain('handoff_ready=yes');
    // Compact: no JSON dump in human mode.
    expect(out).not.toContain('"handoff_state"');
  });
});
