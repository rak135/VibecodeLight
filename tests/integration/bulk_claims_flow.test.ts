import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { registerAgent } from '../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../src/core/coordination/bulk_claims.js';
import { getFinalizeCheck } from '../../src/core/coordination/finalize_check.js';
import { runCommitGuard } from '../../src/core/coordination/commit_guard.js';
import { getSessionBootstrap } from '../../src/core/agent_session/bootstrap.js';

/**
 * Phase 2A integration: bulk-created claims behave exactly like normal advisory
 * claims for git_changes / finalize / commit guard, the declared work intent is
 * visible in session_bootstrap, and extending an intent with a lockfile unblocks
 * finalize for that file.
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

const noCodegraph = async () => ({ available: false, initialized: false, version: null });

describe('Phase 2A — bulk claim → finalize → commit guard flow', () => {
  test('build flow: bootstrap intent summary, finalize sees bulk claims, guarded commit', async () => {
    const repo = makeRepo('vibecode-2a-flow-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'add alpha' } });

    const bulk = addBulkClaims({
      repoRoot: repo,
      agent_id: agent.agent_id,
      intent: 'add alpha feature',
      paths: ['src/alpha.ts', 'tests/alpha.test.ts'],
    });
    expect(bulk.status).toBe('ok');

    // session_bootstrap surfaces the declared work intent compactly.
    const boot = await getSessionBootstrap({ repoRoot: repo, agent_id: agent.agent_id, codegraphStatus: noCodegraph });
    expect(boot.active_work_intents).toHaveLength(1);
    expect(boot.active_work_intents[0]).toMatchObject({
      intent_id: bulk.intent_id,
      intent: 'add alpha feature',
      claim_count: 2,
    });
    expect(boot.active_work_intents[0].sample_paths).toContain('src/alpha.ts');

    // Edit the claimed files → finalize classifies them as this agent's.
    write(repo, 'src/alpha.ts', 'export const a = 1;\n');
    write(repo, 'tests/alpha.test.ts', 'test\n');

    const finalize = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(finalize.status).toBe('ok');
    expect(finalize.summary.allowed_count).toBe(2);
    expect(finalize.summary.unclaimed_count).toBe(0);

    // The scoped commit guard commits exactly the bulk-claimed files.
    const guard = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, message: 'feat: alpha' });
    expect(guard.status).toBe('committed');
    expect(guard.committed_files.sort()).toEqual(['src/alpha.ts', 'tests/alpha.test.ts']);
  });

  test('two-agent conflict: overlapping bulk claim blocks atomically and records a conflict', () => {
    const repo = makeRepo('vibecode-2a-conflict-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'a' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'b' } });

    addBulkClaims({ repoRoot: repo, agent_id: a.agent_id, intent: 'alpha', paths: ['src/alpha.ts', 'src/shared.ts'] });
    const blocked = addBulkClaims({ repoRoot: repo, agent_id: b.agent_id, intent: 'beta', paths: ['src/beta.ts', 'src/shared.ts'] });

    expect(blocked.status).toBe('blocked');
    expect(blocked.created_claims).toEqual([]);
    expect(blocked.blocked_paths.map((p) => p.path)).toEqual(['src/shared.ts']);
    expect(blocked.conflict_id).toMatch(/^conflict-/);
  });

  test('extension: claiming a dirty lockfile via the same intent unblocks finalize', () => {
    const repo = makeRepo('vibecode-2a-lock-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'add alpha' } });
    const bulk = addBulkClaims({ repoRoot: repo, agent_id: agent.agent_id, intent: 'add alpha', paths: ['src/alpha.ts'] });

    write(repo, 'src/alpha.ts', 'export const a = 1;\n');
    write(repo, 'package-lock.json', '{ "name": "x" }\n');

    // The unclaimed dirty lockfile blocks finalize.
    const before = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(before.status).toBe('blocked');
    expect(before.blocks.some((b) => b.path === 'package-lock.json')).toBe(true);

    // Extend the SAME intent to declare the lockfile explicitly.
    const extend = addBulkClaims({
      repoRoot: repo,
      agent_id: agent.agent_id,
      intent_id: bulk.intent_id ?? undefined,
      paths: ['package-lock.json'],
    });
    expect(extend.status).toBe('ok');
    expect(extend.created_claims.map((c) => c.path)).toEqual(['package-lock.json']);

    const after = getFinalizeCheck({ repoRoot: repo, agent_id: agent.agent_id });
    expect(after.status).toBe('ok');
    expect(after.summary.allowed_count).toBe(2);
  });
});
