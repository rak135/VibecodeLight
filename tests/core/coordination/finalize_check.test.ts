import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { getFinalizeCheck, type FinalizeCheckResult } from '../../../src/core/coordination/finalize_check.js';
import { registerAgent, markAgentTerminated } from '../../../src/core/coordination/agents.js';
import { addFileClaim, releaseFileClaim } from '../../../src/core/coordination/claims.js';
import { writeAgentBinding } from '../../../src/core/coordination/agent_binding.js';
import { getWorkspacePaths } from '../../../src/core/workspace/paths.js';

/**
 * Phase 4A finalize check — exercised against REAL git working trees and REAL
 * coordination state written by the core services. The check is read-only; the
 * "no git mutation" test pins that contract directly.
 */
function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string, opts: { gitignoreVibecode?: boolean } = {}): string {
  const ignore = opts.gitignoreVibecode !== false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo with spaces');
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

function write(repo: string, rel: string, content = 'x\n'): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function file(result: FinalizeCheckResult, p: string) {
  const found = result.changed_files.find((f) => f.path === p);
  if (!found) throw new Error(`no changed file for ${p}; got ${result.changed_files.map((f) => f.path).join(', ')}`);
  return found;
}

const T0 = '2026-01-01T00:00:00.000Z';
const T_LATER = '2026-01-01T01:00:00.000Z'; // > heartbeat TTL after T0

describe('getFinalizeCheck — agent resolution', () => {
  test('clean working tree with an active agent is status ok', () => {
    const repo = makeRepo('vibecode-fc-clean-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.blocks).toEqual([]);
    expect(result.changed_files).toEqual([]);
    expect(result.agent?.agent_id).toBe(agent.agent_id);
  });

  test('missing agent id is a blocked AGENT_NOT_FOUND result', () => {
    const repo = makeRepo('vibecode-fc-noagent-');
    const result = getFinalizeCheck({ repoRoot: repo, agent_id: 'agent-does-not-exist' });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('AGENT_NOT_FOUND');
    expect(result.agent).toBeNull();
  });

  test('stale current agent is blocked AGENT_NOT_ACTIVE', () => {
    const repo = makeRepo('vibecode-fc-stale-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id, now: T_LATER });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('AGENT_NOT_ACTIVE');
  });

  test('terminated current agent is blocked AGENT_NOT_ACTIVE', () => {
    const repo = makeRepo('vibecode-fc-term-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    markAgentTerminated(repo, agent.agent_id);
    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('AGENT_NOT_ACTIVE');
  });

  test('neither agent_id nor run_id is an invocation failure (ok false)', () => {
    const repo = makeRepo('vibecode-fc-neither-');
    const result = getFinalizeCheck({ repoRoot: repo });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
  });
});

describe('getFinalizeCheck — run binding resolution', () => {
  function runDirFor(repo: string, runId: string): string {
    return path.join(getWorkspacePaths(repo).runs, runId);
  }

  test('--run resolves the bound agent', () => {
    const repo = makeRepo('vibecode-fc-runbind-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    writeAgentBinding(runDirFor(repo, 'run1'), {
      agent_id: agent.agent_id,
      terminal_session_id: null,
      agent_mode: 'mcp',
      coordination_enabled: true,
    });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = getFinalizeCheck({ repoRoot: repo, run_id: 'run1' });
    expect(result.ok).toBe(true);
    expect(result.run_id).toBe('run1');
    expect(result.agent?.agent_id).toBe(agent.agent_id);
    expect(result.status).toBe('ok');
    expect(file(result, 'src/a.ts').classification).toBe('claimed_by_agent');
  });

  test('missing run binding is blocked RUN_BINDING_NOT_FOUND', () => {
    const repo = makeRepo('vibecode-fc-nobind-');
    const result = getFinalizeCheck({ repoRoot: repo, run_id: 'run-without-binding' });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('RUN_BINDING_NOT_FOUND');
  });

  test('invalid traversal run_id is rejected without reading outside runs', () => {
    const repo = makeRepo('vibecode-fc-badrun-');
    const outside = path.resolve(getWorkspacePaths(repo).runs, '../../outside');

    const result = getFinalizeCheck({ repoRoot: repo, run_id: '../../outside' });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('INVALID_RUN_ID');
    expect(fs.existsSync(outside)).toBe(false);
  });

  test('absolute run_id is rejected safely', () => {
    const repo = makeRepo('vibecode-fc-absrun-');
    const absoluteRunId = path.resolve(path.dirname(repo), 'outside-run');

    const result = getFinalizeCheck({ repoRoot: repo, run_id: absoluteRunId });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('INVALID_RUN_ID');
    expect(fs.existsSync(absoluteRunId)).toBe(false);
  });

  test('explicit --agent and --run that disagree is blocked RUN_AGENT_MISMATCH', () => {
    const repo = makeRepo('vibecode-fc-mismatch-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    writeAgentBinding(runDirFor(repo, 'run1'), {
      agent_id: b.agent_id,
      terminal_session_id: null,
      agent_mode: 'mcp',
      coordination_enabled: true,
    });
    const result = getFinalizeCheck({ repoRoot: repo, agent_id: a.agent_id, run_id: 'run1' });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('RUN_AGENT_MISMATCH');
  });
});

describe('getFinalizeCheck — changed file classification', () => {
  test('a file covered by the current agent active claim is allowed', () => {
    const repo = makeRepo('vibecode-fc-claimed-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('ok');
    const f = file(result, 'src/a.ts');
    expect(f.classification).toBe('claimed_by_agent');
    expect(f.owning_agent_id).toBe(agent.agent_id);
    expect(result.summary.allowed_count).toBe(1);
  });

  test('an unclaimed changed file is blocked UNCLAIMED_CHANGED_FILE', () => {
    const repo = makeRepo('vibecode-fc-unclaimed-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    write(repo, 'src/a.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    const f = file(result, 'src/a.ts');
    expect(f.classification).toBe('unclaimed');
    const block = result.blocks.find((b) => b.path === 'src/a.ts');
    expect(block?.code).toBe('UNCLAIMED_CHANGED_FILE');
    expect(result.summary.unclaimed_count).toBe(1);
  });

  test('a file claimed by another active agent is a warning FILE_CLAIMED_BY_OTHER_AGENT (not a block)', () => {
    const repo = makeRepo('vibecode-fc-other-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/b.ts', mode: 'exclusive' });
    write(repo, 'src/b.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: a.agent_id });
    expect(result.status).toBe('warning');
    const f = file(result, 'src/b.ts');
    expect(f.classification).toBe('claimed_by_other_active_agent');
    expect(f.owning_agent_id).toBe(b.agent_id);
    expect(result.blocks.find((bl) => bl.path === 'src/b.ts')).toBeUndefined();
    const warning = result.warnings.find((w) => w.path === 'src/b.ts');
    expect(warning?.code).toBe('FILE_CLAIMED_BY_OTHER_AGENT');
    expect(result.summary.other_claimed_count).toBe(1);
  });

  test('non-overlapping parallel: Agent A finalize is not blocked by Agent B claimed file', () => {
    const repo = makeRepo('vibecode-fc-parallel-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/alpha.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/beta.ts', mode: 'exclusive' });
    write(repo, 'src/alpha.ts');
    write(repo, 'src/beta.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: a.agent_id });
    expect(result.status).not.toBe('blocked');
    expect(file(result, 'src/alpha.ts').classification).toBe('claimed_by_agent');
    expect(file(result, 'src/beta.ts').classification).toBe('claimed_by_other_active_agent');
    expect(result.blocks.map((b) => b.code)).not.toContain('FILE_CLAIMED_BY_OTHER_AGENT');
    expect(result.warnings.find((w) => w.code === 'FILE_CLAIMED_BY_OTHER_AGENT')?.path).toBe('src/beta.ts');
    expect(result.summary.allowed_count).toBe(1);
    expect(result.summary.other_claimed_count).toBe(1);
  });

  test('unclaimed dirty file still blocks even when other-agent file is a warning', () => {
    const repo = makeRepo('vibecode-fc-mixed-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/alpha.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/beta.ts', mode: 'exclusive' });
    write(repo, 'src/alpha.ts');
    write(repo, 'src/beta.ts');
    write(repo, 'src/unclaimed.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: a.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.blocks.find((bl) => bl.code === 'UNCLAIMED_CHANGED_FILE')?.path).toBe('src/unclaimed.ts');
    expect(result.warnings.find((w) => w.code === 'FILE_CLAIMED_BY_OTHER_AGENT')?.path).toBe('src/beta.ts');
  });

  test('stale agent claim does not downgrade to warning (remains unclaimed block)', () => {
    const repo = makeRepo('vibecode-fc-stale-other-');
    const stale = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    addFileClaim(repo, { agent_id: stale.agent_id, path: 'src/b.ts', mode: 'exclusive' }, { now: T0 });
    const active = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_LATER });
    write(repo, 'src/b.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: active.agent_id, now: T_LATER });
    expect(result.status).toBe('blocked');
    expect(file(result, 'src/b.ts').classification).toBe('unclaimed');
    expect(result.blocks.find((b) => b.path === 'src/b.ts')?.code).toBe('UNCLAIMED_CHANGED_FILE');
  });

  test('a changed .vibecode runtime file is generated_or_ignored and does not block', () => {
    const repo = makeRepo('vibecode-fc-generated-', { gitignoreVibecode: false });
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    write(repo, path.join('.vibecode', 'changed.json'), '{}\n');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.blocks).toEqual([]);
    expect(result.status).not.toBe('blocked');
    const f = file(result, '.vibecode/changed.json');
    expect(f.classification).toBe('generated_or_ignored');
    // every changed file in this fixture is .vibecode generated runtime state
    expect(result.changed_files.every((cf) => cf.classification === 'generated_or_ignored')).toBe(true);
  });

  test('a released claim does not authorize a changed file', () => {
    const repo = makeRepo('vibecode-fc-released-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const added = addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    releaseFileClaim(repo, added.claim!.claim_id);
    write(repo, 'src/a.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    expect(file(result, 'src/a.ts').classification).toBe('unclaimed');
  });

  test('a claim owned by a stale agent does not authorize a changed file', () => {
    const repo = makeRepo('vibecode-fc-staleclaim-');
    const stale = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    addFileClaim(repo, { agent_id: stale.agent_id, path: 'src/b.ts', mode: 'exclusive' }, { now: T0 });
    const active = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_LATER });
    write(repo, 'src/b.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: active.agent_id, now: T_LATER });
    expect(result.status).toBe('blocked');
    expect(file(result, 'src/b.ts').classification).toBe('unclaimed');
    expect(result.blocks.find((b) => b.path === 'src/b.ts')?.code).toBe('UNCLAIMED_CHANGED_FILE');
  });
});

describe('getFinalizeCheck — git integration', () => {
  test('git helper failure is blocked GIT_CHANGED_FILES_FAILED', () => {
    // A coordination state can exist in a directory that is not a git repo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-fc-nogit-'));
    const agent = registerAgent(dir, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const result = getFinalizeCheck({ repoRoot: dir, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('GIT_CHANGED_FILES_FAILED');
  });

  test('finalize check does not mutate git state', () => {
    const repo = makeRepo('vibecode-fc-nomutate-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    write(repo, 'src/a.ts');
    git(['add', '--', 'src/a.ts'], repo);

    const headBefore = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    const statusBefore = git(['status', '--porcelain=v1'], repo).stdout;

    getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });

    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(headBefore);
    expect(git(['status', '--porcelain=v1'], repo).stdout).toBe(statusBefore);
  });
});

describe('getFinalizeCheck — commit guard recommendations', () => {
  test('ok status with claimed dirty files includes dry-run commit guard command', () => {
    const repo = makeRepo('vibecode-fc-rec-ok-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('ok');
    expect(result.recommended_cli_commands).toBeDefined();
    expect(result.recommended_cli_commands.length).toBeGreaterThan(0);
    const dryRun = result.recommended_cli_commands.find((c) => c.includes('commit guard') && c.includes('--dry-run'));
    expect(dryRun).toBeDefined();
    expect(dryRun).toContain(agent.agent_id);
    const realCommit = result.recommended_cli_commands.find((c) => c.includes('commit guard') && !c.includes('--dry-run'));
    expect(realCommit).toBeDefined();
    expect(realCommit).toContain('--message');
  });

  test('blocked status by unclaimed dirty file does NOT include commit guard command', () => {
    const repo = makeRepo('vibecode-fc-rec-blocked-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    write(repo, 'src/a.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    const commitGuard = result.recommended_cli_commands.find((c) => c.includes('commit guard'));
    expect(commitGuard).toBeUndefined();
  });

  test('blocked status by read_only agent does NOT include commit guard command', () => {
    const repo = makeRepo('vibecode-fc-rec-readonly-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'read_only', task: 'inspect' } });

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    const commitGuard = result.recommended_cli_commands.find((c) => c.includes('commit guard'));
    expect(commitGuard).toBeUndefined();
  });

  test('blocked status by invalid agent session does NOT include commit guard command', () => {
    const repo = makeRepo('vibecode-fc-rec-invalid-');
    // Register a legacy agent without mode/task.
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    const commitGuard = result.recommended_cli_commands.find((c) => c.includes('commit guard'));
    expect(commitGuard).toBeUndefined();
  });

  test('warning state with own committable files still recommends commit guard', () => {
    const repo = makeRepo('vibecode-fc-rec-warn-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/alpha.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/beta.ts', mode: 'exclusive' });
    write(repo, 'src/alpha.ts');
    write(repo, 'src/beta.ts');

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: a.agent_id });
    expect(result.status).toBe('warning');
    // A has committable files (alpha.ts), so commit guard should be recommended.
    const dryRun = result.recommended_cli_commands.find((c) => c.includes('commit guard') && c.includes('--dry-run'));
    expect(dryRun).toBeDefined();
  });

  test('clean working tree with no changed files does not recommend commit guard', () => {
    const repo = makeRepo('vibecode-fc-rec-clean-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });

    const result = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('ok');
    // No changed files = nothing to commit.
    const commitGuard = result.recommended_cli_commands.find((c) => c.includes('commit guard'));
    expect(commitGuard).toBeUndefined();
  });
});
