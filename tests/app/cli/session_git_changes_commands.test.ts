import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildSessionBootstrapTool } from '../../../src/app/mcp/tools/session_bootstrap.js';
import { buildGitChangesTool } from '../../../src/app/mcp/tools/git_changes.js';
import { registerAgent, markAgentTerminated, listAgents } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import type { SessionBootstrapResult } from '../../../src/core/agent_session/bootstrap.js';
import type { GitChangesSummary } from '../../../src/core/workspace/git_changes_summary.js';

/** Run the CLI in-process, capturing stdout/stderr lines and the exit code. */
async function runCli(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number }> {
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

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  git(['config', 'core.autocrlf', 'false'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function write(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('vibecode session bootstrap --json', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-cli-bootstrap-');
  });
  afterEach(() => {
    repo.cleanup();
    vi.resetModules();
  });

  test('returns a stable success envelope with protocol + recommendations', async () => {
    const result = await runCli(['session', 'bootstrap', '--repo', repo.repoRoot, '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toHaveLength(1);
    const envelope = JSON.parse(result.logs[0]) as { ok: boolean; data: SessionBootstrapResult; artifacts: unknown[]; warnings: unknown[] };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.repo_root).toBe(repo.repoRoot);
    expect(envelope.data.agent_protocol.length).toBeGreaterThan(0);
    expect(envelope.data.recommended_next_tools).toContain('vibecode_changes');
    expect(Array.isArray(envelope.artifacts)).toBe(true);
  });

  test('carries the Phase 3B runtime_awareness preflight with a null server section', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'preflight' } });
    const result = await runCli(['session', 'bootstrap', '--repo', repo.repoRoot, '--agent', agent.agent_id, '--json']);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.logs[0]) as { ok: boolean; data: SessionBootstrapResult };
    const ra = envelope.data.runtime_awareness;
    expect(ra.agent.agent_id).toBe(agent.agent_id);
    expect(ra.agent.status).toBe('active');
    expect(ra.commit_guard.can_edit).toBe(true);
    // The CLI always runs the current build, so it has no live-server identity.
    expect(ra.server).toBeNull();
  });

  test('carries the Phase 3C recovery guidance in JSON and a compact Recovery line in human output', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'recovery' } });
    addFileClaim(repo.repoRoot, { agent_id: agent.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    write(repo.repoRoot, 'src/mine.ts');

    const json = await runCli(['session', 'bootstrap', '--repo', repo.repoRoot, '--agent', agent.agent_id, '--json']);
    expect(json.exitCode).toBe(0);
    const envelope = JSON.parse(json.logs[0]) as { data: SessionBootstrapResult };
    const recovery = envelope.data.runtime_awareness.recovery;
    expect(recovery.resume_state).toBe('ready_to_commit');
    expect(recovery.recommended_cli_commands.some((c) => c.includes('commit guard') && c.includes('--dry-run'))).toBe(true);

    const human = await runCli(['session', 'bootstrap', '--repo', repo.repoRoot, '--agent', agent.agent_id]);
    expect(human.exitCode).toBe(0);
    const recoveryLines = human.logs.filter((l) => l.startsWith('Recovery: '));
    expect(recoveryLines).toHaveLength(1);
    expect(recoveryLines[0]).toContain('ready_to_commit');
  });

  test('--register --agent-mode build --task creates an agent', async () => {
    const result = await runCli([
      'session', 'bootstrap', '--repo', repo.repoRoot,
      '--register', '--agent-mode', 'build', '--type', 'claude', '--task', 'do work', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.logs[0]) as { ok: boolean; data: SessionBootstrapResult };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.current_agent?.operating_mode).toBe('build');
    expect(listAgents(repo.repoRoot)).toHaveLength(1);
  });

  test('terminated agent_id returns a structured error envelope', async () => {
    const agent = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    markAgentTerminated(repo.repoRoot, agent.agent_id);
    const result = await runCli(['session', 'bootstrap', '--repo', repo.repoRoot, '--agent', agent.agent_id, '--json']);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('AGENT_TERMINATED');
  });

  test('--register with invalid mode returns a structured error envelope', async () => {
    const result = await runCli(['session', 'bootstrap', '--repo', repo.repoRoot, '--register', '--agent-mode', 'nope', '--task', 'x', '--json']);
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.logs[0]) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_AGENT_MODE');
  });
});

describe('vibecode git changes --json', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-cli-gitchanges-');
  });
  afterEach(() => {
    repo.cleanup();
    vi.resetModules();
  });

  test('returns a stable success envelope', async () => {
    write(repo.repoRoot, 'src/a.ts');
    const result = await runCli(['git', 'changes', '--repo', repo.repoRoot, '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toHaveLength(1);
    const envelope = JSON.parse(result.logs[0]) as { ok: boolean; data: GitChangesSummary };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.summary.changed_count).toBe(1);
    expect(envelope.data.files[0].classification).toBe('unknown_without_agent_id');
  });

  test('a non-git directory returns a structured error envelope', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cli-nogit-'));
    try {
      const result = await runCli(['git', 'changes', '--repo', dir, '--json']);
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.logs[0]) as { ok: boolean; error: { code: string } };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('GIT_CHANGES_FAILED');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI/MCP parity (Phase 1A)', () => {
  test('session bootstrap: protocol, recommendations, and git counts match the MCP tool', async () => {
    const repo = makeRepo('vibecode-parity-bs-');
    try {
      write(repo.repoRoot, 'src/a.ts');
      const cli = await runCli(['session', 'bootstrap', '--repo', repo.repoRoot, '--json']);
      const cliData = (JSON.parse(cli.logs[0]) as { data: SessionBootstrapResult }).data;

      const mcp = await buildSessionBootstrapTool({
        codegraphStatus: async () => ({ available: false, initialized: false, version: null }),
      }).handler({ context: { repoRoot: repo.repoRoot }, arguments: {}, requestId: null });
      const mcpData = mcp.structuredContent.data as SessionBootstrapResult;

      expect(cliData.agent_protocol).toEqual(mcpData.agent_protocol);
      expect(cliData.recommended_next_tools).toEqual(mcpData.recommended_next_tools);
      expect(cliData.recommended_cli_commands).toEqual(mcpData.recommended_cli_commands);
      expect(cliData.git.changed_counts).toEqual(mcpData.git.changed_counts);
      expect(cliData.claims.counts).toEqual(mcpData.claims.counts);
      // Phase 3B: the preflight matches except for the server section, which
      // only the live MCP server fills (CLI always reflects the current build).
      expect(cliData.runtime_awareness.server).toBeNull();
      expect(mcpData.runtime_awareness.server).not.toBeNull();
      // checked_at is the only timing-dependent field; normalize it and the
      // adapter-filled server section for the structural comparison.
      expect({ ...cliData.runtime_awareness, server: null, checked_at: 'T' }).toEqual({
        ...mcpData.runtime_awareness,
        server: null,
        checked_at: 'T',
      });
    } finally {
      repo.cleanup();
    }
  });

  test('git changes: classification + counts match the MCP tool', async () => {
    const repo = makeRepo('vibecode-parity-gc-');
    try {
      const a = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
      addFileClaim(repo.repoRoot, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
      write(repo.repoRoot, 'src/mine.ts');
      write(repo.repoRoot, 'src/loose.ts');

      const cli = await runCli(['git', 'changes', '--repo', repo.repoRoot, '--agent', a.agent_id, '--json']);
      const cliData = (JSON.parse(cli.logs[0]) as { data: GitChangesSummary }).data;

      const mcp = await buildGitChangesTool().handler({
        context: { repoRoot: repo.repoRoot },
        arguments: { agent_id: a.agent_id },
        requestId: null,
      });
      const mcpData = mcp.structuredContent.data as GitChangesSummary;

      expect(cliData.summary).toEqual(mcpData.summary);
      expect(cliData.files.map((f) => [f.path, f.classification])).toEqual(
        mcpData.files.map((f) => [f.path, f.classification]),
      );
    } finally {
      repo.cleanup();
    }
  });
});
