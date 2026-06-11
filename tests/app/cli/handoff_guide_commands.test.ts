import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';
import type { NextAgentHandoffGuide } from '../../../src/core/agent_session/handoff_guide.js';

/**
 * Phase 4B — `vibecode handoff guide` CLI contract.
 *
 * What breaks if removed:
 *   - the CLI could lose parity with the MCP tool (same core service, same
 *     guide shape, canonical JSON envelope);
 *   - missing/invalid --from-agent or --max-items could stop being rejected;
 *   - --for-agent could stop changing the next-agent-specific recommendations;
 *   - the guide could silently start mutating state (it must stay read-only).
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

interface SuccessEnvelope { ok: true; data: NextAgentHandoffGuide; artifacts: unknown[]; warnings: string[] }
interface ErrorEnvelope { ok: false; error: { code: string; message: string } }

describe('vibecode handoff guide (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-handoff-guide-cli-')));
  afterEach(() => repo.cleanup());

  async function register(task: string): Promise<string> {
    const res = await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', 'build', '--task', task, '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as { data: { current_agent: { agent_id: string } } };
    return env.data.current_agent.agent_id;
  }

  test('--json without --for-agent returns next_agent_not_registered in the canonical envelope', async () => {
    const fromId = await register('phase 4b producer');
    const res = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.from_agent_id).toBe(fromId);
    expect(env.data.for_agent_id).toBeNull();
    expect(env.data.onboarding.onboarding_state).toBe('next_agent_not_registered');
    expect(env.data.onboarding.ownership_transferred).toBe(false);
    expect(env.data.do_not_do.length).toBeGreaterThan(0);
    expect(Array.isArray(env.artifacts)).toBe(true);
  });

  test('--for-agent changes the next-agent-specific recommendations', async () => {
    const fromId = await register('phase 4b producer');
    const forId = await register('phase 4b consumer');

    const without = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId, '--json']);
    const withFor = await runCli([
      'handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId, '--for-agent', forId, '--json',
    ]);
    const envWithout = JSON.parse(without.logs[0]) as SuccessEnvelope;
    const envWith = JSON.parse(withFor.logs[0]) as SuccessEnvelope;

    expect(envWithout.data.onboarding.onboarding_state).toBe('next_agent_not_registered');
    expect(envWith.data.onboarding.onboarding_state).toBe('ready_for_new_agent');
    expect(envWith.data.onboarding.can_continue_now).toBe(true);
    expect(envWith.data.next_agent_cli_commands.join(' ')).toContain(forId);
    expect(envWithout.data.next_agent_cli_commands.join(' ')).toContain('session bootstrap --register');
  });

  test('same-agent --for-agent routes to session recovery and suppresses cross-agent continuation', async () => {
    const fromId = await register('phase 4b same-agent resume');

    const json = await runCli([
      'handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId, '--for-agent', fromId, '--json',
    ]);
    expect(json.exitCode).toBe(0);
    const env = JSON.parse(json.logs[0]) as SuccessEnvelope;
    expect(env.data.onboarding.same_agent_resume).toBe(true);
    expect(env.data.onboarding.onboarding_state).toBe('same_agent_resume');
    expect(env.data.onboarding.can_continue_now).toBe(false);
    expect(env.data.onboarding.ownership_transferred).toBe(false);
    expect(env.data.onboarding.must_claim_explicitly).toBe(true);
    const next = env.data.next_agent_cli_commands.join(' ');
    expect(next).toContain('session_recovery');
    expect(next).not.toContain('claims plan');
    expect(next).not.toContain('build_pre_edit');

    const human = await runCli([
      'handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId, '--for-agent', fromId,
    ]);
    const out = human.logs.join('\n');
    expect(out).toMatch(/same-agent resume/i);
    expect(out).toContain('session_recovery');
    expect(out).not.toMatch(/ready_for_new_agent|ready for new agent/i);
    expect(out).not.toContain('- vibecode claims plan');
    expect(out).not.toContain('build_pre_edit');
  });

  test('missing --from-agent is a structured MISSING_REQUIRED_OPTION error', async () => {
    const res = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--json']);
    expect(res.exitCode).not.toBe(0);
    const env = JSON.parse(res.logs[res.logs.length - 1]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('MISSING_REQUIRED_OPTION');
  });

  test('invalid and over-cap --max-items are rejected with INVALID_ARGUMENT', async () => {
    for (const value of ['0', '-2', '1.5', 'ten', '51']) {
      const res = await runCli([
        'handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', 'agent-x', '--max-items', value, '--json',
      ]);
      expect(res.exitCode).not.toBe(0);
      const env = JSON.parse(res.logs[res.logs.length - 1]) as ErrorEnvelope;
      expect(env.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('unknown from-agent id yields a safe onboarding state, not an error', async () => {
    const res = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', 'agent-gone', '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.data.handoff_source.handoff_state).toBe('terminated_or_missing_agent');
    expect(env.warnings.some((w) => w.includes('PREVIOUS_AGENT_UNAVAILABLE'))).toBe(true);
  });

  test('release-needed flow: previous-agent commands separated from next-agent commands, no mutation', async () => {
    const fromId = await register('phase 4b producer');
    await runCli(['claims', 'add-bulk', '--repo', repo.repoRoot, '--agent', fromId, '--intent', 'work', '--path', 'src/mine.ts', '--json']);
    const before = git(['status', '--porcelain'], repo.repoRoot).stdout;

    const res = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId, '--json']);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect(env.data.onboarding.onboarding_state).toBe('previous_agent_ready_after_release');
    const prev = env.data.previous_agent_cli_commands.join(' ');
    expect(prev).toContain(`intent-release --agent ${fromId}`);
    expect(prev).toContain('--dry-run');
    expect(env.data.next_agent_cli_commands.join(' ')).not.toContain('intent-release');
    expect(env.data.blocked_paths).toContain('src/mine.ts');
    expect(git(['status', '--porcelain'], repo.repoRoot).stdout).toBe(before);
  });

  test('claim-only release-needed flow uses claim release, not intent release', async () => {
    const fromId = await register('phase 4b claim-only producer');
    const added = await runCli([
      'claims', 'add', '--repo', repo.repoRoot, '--agent', fromId, '--path', 'src/claim-only.ts', '--json',
    ]);
    expect(added.exitCode).toBe(0);

    const json = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId, '--json']);
    expect(json.exitCode).toBe(0);
    const env = JSON.parse(json.logs[0]) as SuccessEnvelope;
    expect(env.data.onboarding.onboarding_state).toBe('previous_agent_ready_after_release');
    expect(env.data.onboarding.can_continue_now).toBe(false);
    expect(env.data.onboarding.ownership_transferred).toBe(false);
    expect(env.data.onboarding.must_claim_explicitly).toBe(true);
    expect(env.data.required_before_continue).toContain('previous_agent_release_claims');
    expect(env.data.required_before_continue).not.toContain('previous_agent_release_intents');
    const prev = env.data.previous_agent_cli_commands.join(' ');
    expect(prev).toContain('claims list');
    expect(prev).toContain('claims release --claim <claim_id> --json');
    expect(prev).not.toContain('intent-release');

    const human = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId]);
    const out = human.logs.join('\n');
    expect(out).toContain('previous_agent_release_claims');
    expect(out).toMatch(/active claims/i);
    expect(out).not.toContain('intent-release');
  });

  test('human output is compact with the onboarding summary and do_not_do', async () => {
    const fromId = await register('phase 4b producer');
    const res = await runCli(['handoff', 'guide', '--repo', repo.repoRoot, '--from-agent', fromId]);
    expect(res.exitCode).toBe(0);
    const out = res.logs.join('\n');
    expect(out).toContain('Onboarding: next_agent_not_registered');
    expect(out).toContain('do_not_do:');
    expect(out).toContain('ownership_transferred=no');
    // Compact: no JSON dump in human mode.
    expect(out).not.toContain('"onboarding_state"');
  });
});
