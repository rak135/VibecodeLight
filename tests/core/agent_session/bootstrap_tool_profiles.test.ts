import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { getSessionBootstrap } from '../../../src/core/agent_session/bootstrap.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';

/**
 * Phase 1B-3: session_bootstrap surfaces compact, context-aware
 * recommended_tool_profiles (ids + reasons). These pin the deterministic mapping
 * from agent mode / edit state / scan / conflicts to profile ids so the safe
 * path stays visible without dumping full profiles.
 */

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repo);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  return repo;
}

function write(repo: string, rel: string, content = 'x\n'): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

/** Seed a current run pointer with optional scan artifact / run artifact. */
function seedCurrentRun(repo: string, runId: string, opts: { scan?: boolean; artifact?: boolean }): void {
  const runDir = path.join(repo, '.vibecode', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 't', status: 'done', repo_root: repo }),
    'utf8',
  );
  if (opts.scan) {
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'scan', 'file_inventory.json'), JSON.stringify([{ path: 'src/a.ts' }]), 'utf8');
  }
  if (opts.artifact) {
    fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'output', 'final_prompt.md'), '# fp\n', 'utf8');
  }
  const currentDir = path.join(repo, '.vibecode', 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  fs.writeFileSync(
    path.join(currentDir, 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 't' }),
    'utf8',
  );
}

const STUB_CODEGRAPH = async () => ({ available: false, initialized: false, version: null });
const baseOpts = { codegraphStatus: STUB_CODEGRAPH } as const;

function ids(profiles: Array<{ profile_id: string }>): string[] {
  return profiles.map((p) => p.profile_id);
}

describe('session_bootstrap — recommended_tool_profiles', () => {
  test('read_only agent is recommended read_only_orientation', async () => {
    const repo = makeRepo('vibecode-tp-ro-');
    const agent = registerAgent(repo, { agent_name: 'RO', agent_type: 'claude', metadata: { operating_mode: 'read_only', task: 'review' } });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, ...baseOpts });
    expect(result.ok).toBe(true);
    expect(ids(result.recommended_tool_profiles)).toContain('read_only_orientation');
    // Each recommendation carries a short reason.
    for (const r of result.recommended_tool_profiles) expect(r.reason.length).toBeGreaterThan(0);
  });

  test('registered build agent with no claimed dirty files is recommended build_pre_edit', async () => {
    const repo = makeRepo('vibecode-tp-pre-');
    const agent = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'feature' } });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, ...baseOpts });
    expect(result.ok).toBe(true);
    const got = ids(result.recommended_tool_profiles);
    expect(got).toContain('build_pre_edit');
    expect(got).not.toContain('build_post_edit');
  });

  test('build agent with a dirty claimed file is recommended build_post_edit and safe_commit', async () => {
    const repo = makeRepo('vibecode-tp-post-');
    const agent = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'feature' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts'); // now dirty AND claimed by this agent
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, ...baseOpts });
    expect(result.ok).toBe(true);
    const got = ids(result.recommended_tool_profiles);
    expect(got).toContain('build_post_edit');
    expect(got).toContain('safe_commit');
    expect(got).not.toContain('build_pre_edit');
  });

  test('scan availability adds scan_inspection; run artifacts add artifact_continuation', async () => {
    const repo = makeRepo('vibecode-tp-scan-');
    seedCurrentRun(repo, 'r1', { scan: true, artifact: true });
    const agent = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'feature' } });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, ...baseOpts });
    expect(result.scan.current_run_scan_available).toBe(true);
    const got = ids(result.recommended_tool_profiles);
    expect(got).toContain('scan_inspection');
    expect(got).toContain('artifact_continuation');
  });

  test('possibly-stale other-agent claims add conflict_resolution', async () => {
    const repo = makeRepo('vibecode-tp-conflict-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'feature' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'feature' } });
    // B claims a clean (not dirty) file → possibly-stale active claim from A's view.
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/clean.ts', mode: 'exclusive' });
    const result = await getSessionBootstrap({ repoRoot: repo, agent_id: a.agent_id, ...baseOpts });
    expect(ids(result.recommended_tool_profiles)).toContain('conflict_resolution');
  });

  test('unregistered orientation is recommended read_only_orientation (and existing recommendations remain)', async () => {
    const repo = makeRepo('vibecode-tp-unreg-');
    const result = await getSessionBootstrap({ repoRoot: repo, ...baseOpts });
    expect(ids(result.recommended_tool_profiles)).toContain('read_only_orientation');
    // The Phase 1A recommendations must still be present and not bloated.
    expect(result.recommended_next_tools.length).toBeGreaterThan(0);
    expect(result.recommended_tool_profiles.length).toBeLessThanOrEqual(5);
  });
});
