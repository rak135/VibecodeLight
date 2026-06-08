import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import {
  getSessionBootstrap,
  AGENT_OPERATING_PROTOCOL,
} from '../../../src/core/agent_session/bootstrap.js';
import { registerAgent, markAgentTerminated, listAgents } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';

/**
 * Phase 1A — session bootstrap aggregator. Exercised against REAL git working
 * trees + REAL coordination state. CodeGraph status is stubbed so tests never
 * spawn the upstream binary.
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

const STUB_CODEGRAPH = async () => ({ available: false, initialized: false, version: null });
const baseOpts = { codegraphStatus: STUB_CODEGRAPH } as const;

const T0 = '2026-01-01T00:00:00.000Z';
const T_LATER = '2026-01-01T01:00:00.000Z'; // > heartbeat TTL after T0

describe('getSessionBootstrap — git + orientation', () => {
  test('clean repo: dirty false, protocol + recommendations present', async () => {
    const repo = makeRepo('vibecode-bs-clean-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.git.available).toBe(true);
    expect(result.git.dirty).toBe(false);
    expect(result.git.changed_counts.total).toBe(0);
    expect(result.agent_protocol).toEqual([...AGENT_OPERATING_PROTOCOL]);
    expect(result.recommended_next_tools.length).toBeGreaterThan(0);
    expect(result.recommended_cli_commands.length).toBeGreaterThan(0);
    expect(result.recommended_next_tools).toContain('vibecode_git_changes');
  });

  test('dirty repo: changed counts and sample paths are populated', async () => {
    const repo = makeRepo('vibecode-bs-dirty-');
    write(repo, 'src/a.ts');
    write(repo, 'src/b.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.git.dirty).toBe(true);
    expect(result.git.changed_counts.total).toBe(2);
    expect(result.git.changed_counts.untracked).toBe(2);
    expect(result.git.sample_changed_files.length).toBeGreaterThan(0);
  });

  test('generated_or_ignored is surfaced in changed_counts', async () => {
    const repo = makeRepo('vibecode-bs-generated-', { gitignoreVibecode: false });
    // Write a .vibecode file (generated runtime path) and a source file.
    write(repo, path.join('.vibecode', 'coordination', 'state.json'), '{}\n');
    write(repo, 'src/a.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    // generated_or_ignored is present and counts .vibecode/ paths.
    expect(result.git.changed_counts.generated_or_ignored).toBeGreaterThanOrEqual(1);
    // The source file is counted separately as untracked.
    expect(result.git.changed_counts.untracked).toBeGreaterThanOrEqual(1);
    // Total is the total number of changed files.
    expect(result.git.changed_counts.total).toBeGreaterThanOrEqual(2);
  });

  test('defensive cap: rejects max_items above hard max', async () => {
    const repo = makeRepo('vibecode-bs-cap-reject-');
    await expect(
      getSessionBootstrap({ repoRoot: repo, max_items: 101, ...baseOpts }),
    ).rejects.toThrow(/exceeds maximum/);
  });

  test('defensive cap: accepts max_items at hard max (100)', async () => {
    const repo = makeRepo('vibecode-bs-cap-boundary-');
    const result = await getSessionBootstrap({ repoRoot: repo, max_items: 100, ...baseOpts });
    expect(result.ok).toBe(true);
  });

  test('bounded sections: agents/claims/conflicts/evidence/scan/codegraph present', async () => {
    const repo = makeRepo('vibecode-bs-sections-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.agents).toMatchObject({ total: 0, active: 0, stale: 0, terminated: 0 });
    expect(result.claims.counts).toMatchObject({ own: 0, other_active: 0, stale: 0 });
    expect(result.conflicts.unresolved_count).toBe(0);
    expect(result.evidence).toHaveProperty('recent_count');
    expect(result.codegraph).toMatchObject({ available: false, initialized: false });
    // Phase 1A: scan reports availability ONLY — no scan_summary sections.
    expect(result.scan).toHaveProperty('current_run_scan_available');
    expect(result.scan).not.toHaveProperty('sections');
    expect(result.scan).not.toHaveProperty('summary');
  });

  test('bounded project-instruction excerpt is included from AGENTS.md', async () => {
    const repo = makeRepo('vibecode-bs-instr-');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# AGENTS\n\nClaim before editing.\n', 'utf8');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(result.project_instructions.available).toBe(true);
    expect(result.project_instructions.sources).toContain('AGENTS.md');
    expect(typeof result.project_instructions.excerpt).toBe('string');
    expect(result.project_instructions.excerpt).toContain('AGENTS');
  });
});

describe('getSessionBootstrap — agent identity', () => {
  test('register=true creates an agent with operating mode + task and writes generated state', async () => {
    const repo = makeRepo('vibecode-bs-register-');
    const result = await getSessionBootstrap({
      repoRoot: repo,
      register: true,
      agent_mode: 'build',
      agent_name: 'Builder 1',
      agent_type: 'claude',
      task: 'implement phase 1a',
      ...baseOpts,
    });
    expect(result.ok).toBe(true);
    expect(result.generated_state_written).toBe(true);
    expect(result.current_agent).not.toBeNull();
    expect(result.current_agent?.operating_mode).toBe('build');
    expect(result.current_agent?.task).toBe('implement phase 1a');

    const agents = listAgents(repo);
    expect(agents).toHaveLength(1);
    expect(agents[0].metadata.operating_mode).toBe('build');
    expect(agents[0].metadata.task).toBe('implement phase 1a');
  });

  test('register=true requires a valid agent_mode', async () => {
    const repo = makeRepo('vibecode-bs-badmode-');
    const result = await getSessionBootstrap({
      repoRoot: repo,
      register: true,
      agent_mode: 'observer',
      task: 'x',
      ...baseOpts,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('INVALID_AGENT_MODE');
    expect(listAgents(repo)).toHaveLength(0);
  });

  test('register=true requires a task/intent', async () => {
    const repo = makeRepo('vibecode-bs-notask-');
    const result = await getSessionBootstrap({
      repoRoot: repo,
      register: true,
      agent_mode: 'read_only',
      ...baseOpts,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('AGENT_TASK_REQUIRED');
  });

  test('active agent_id heartbeats / refreshes', async () => {
    const repo = makeRepo('vibecode-bs-heartbeat-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, now: T0, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.generated_state_written).toBe(true);
    expect(result.current_agent?.agent_id).toBe(agent.agent_id);
    expect(result.current_agent?.status).toBe('active');
  });

  test('stale agent_id is revived by the bootstrap heartbeat', async () => {
    const repo = makeRepo('vibecode-bs-revive-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, now: T_LATER, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.generated_state_written).toBe(true);
    expect(result.current_agent?.status).toBe('active');
  });

  test('terminated agent_id returns a structured blocker (and writes nothing)', async () => {
    const repo = makeRepo('vibecode-bs-term-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    markAgentTerminated(repo, agent.agent_id);
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, ...baseOpts });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('AGENT_TERMINATED');
    expect(result.generated_state_written).toBe(false);
  });

  test('unknown agent_id returns a structured AGENT_NOT_FOUND blocker', async () => {
    const repo = makeRepo('vibecode-bs-unknown-');
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: 'agent-nope', ...baseOpts });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((b) => b.code)).toContain('AGENT_NOT_FOUND');
  });

  test('missing agent_id with register=false reports a registration warning but still orients', async () => {
    const repo = makeRepo('vibecode-bs-noreg-');
    write(repo, 'src/a.ts');
    const result = await getSessionBootstrap({ repoRoot: repo, register: false, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(result.current_agent).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain('NOT_REGISTERED');
    // Orientation is still returned.
    expect(result.git.dirty).toBe(true);
    expect(result.agent_protocol.length).toBeGreaterThan(0);
  });
});

describe('getSessionBootstrap — coordination summaries', () => {
  test('own / other / stale claims are split and conflicts are summarized', async () => {
    const repo = makeRepo('vibecode-bs-claims-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/theirs.ts', mode: 'exclusive' });

    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, ...baseOpts });
    expect(result.current_agent?.agent_id).toBe(a.agent_id);
    expect(result.claims.counts.own).toBe(1);
    expect(result.claims.counts.other_active).toBe(1);
    expect(result.claims.own[0]?.path).toBe('src/mine.ts');
    expect(result.agents.total).toBe(2);
    expect(result.agents.active).toBe(2);
  });

  test('claim lists are capped by max_items', async () => {
    const repo = makeRepo('vibecode-bs-cap-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    for (let i = 0; i < 5; i += 1) {
      addFileClaim(repo, { agent_id: a.agent_id, path: `src/f${i}.ts`, mode: 'shared' });
    }
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, max_items: 2, ...baseOpts });
    expect(result.claims.counts.own).toBe(5);
    expect(result.claims.own).toHaveLength(2);
  });
});
