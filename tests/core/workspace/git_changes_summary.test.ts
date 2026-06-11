import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import {
  getGitChangesSummary,
  type GitChangesSummary,
} from '../../../src/core/workspace/git_changes_summary.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';

/**
 * Phase 1A — claim-aware git changes summary. Exercised against REAL git
 * working trees and REAL coordination state, mirroring the finalize-check tests.
 * The summary is read-only; the "no git/source mutation" test pins that.
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

function commit(repo: string, message: string): void {
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', message], repo);
}

function fileOf(summary: GitChangesSummary, p: string) {
  const found = summary.files.find((f) => f.path === p);
  if (!found) throw new Error(`no changed file for ${p}; got ${summary.files.map((f) => f.path).join(', ')}`);
  return found;
}

describe('getGitChangesSummary — categories', () => {
  test('reports staged, unstaged, untracked, deleted, and renamed categories', () => {
    const repo = makeRepo('vibecode-gcs-cat-');
    write(repo, 'src/keep.ts', 'a\n');
    write(repo, 'src/old.ts', 'b\n');
    write(repo, 'src/mod.ts', 'c\n');
    commit(repo, 'seed');

    // staged: new file added to index
    write(repo, 'src/staged.ts', 'new\n');
    git(['add', '--', 'src/staged.ts'], repo);
    // unstaged: modify a tracked file without staging
    write(repo, 'src/mod.ts', 'changed\n');
    // untracked: brand new file
    write(repo, 'src/untracked.ts', 'untracked\n');
    // deleted: remove a tracked file in the worktree
    fs.rmSync(path.join(repo, 'src/keep.ts'));
    // renamed: staged rename
    git(['mv', 'src/old.ts', 'src/new.ts'], repo);

    const summary = getGitChangesSummary(repo);
    expect(summary.ok).toBe(true);

    expect(fileOf(summary, 'src/staged.ts').staged).toBe(true);
    expect(fileOf(summary, 'src/staged.ts').categories).toContain('staged');
    expect(fileOf(summary, 'src/mod.ts').unstaged).toBe(true);
    expect(fileOf(summary, 'src/mod.ts').categories).toContain('unstaged');
    expect(fileOf(summary, 'src/untracked.ts').untracked).toBe(true);
    expect(fileOf(summary, 'src/untracked.ts').categories).toContain('untracked');
    expect(fileOf(summary, 'src/keep.ts').categories).toContain('deleted');
    expect(fileOf(summary, 'src/new.ts').categories).toContain('renamed');
    expect(fileOf(summary, 'src/new.ts').original_path).toBe('src/old.ts');

    expect(summary.summary.staged).toBeGreaterThanOrEqual(1);
    expect(summary.summary.untracked).toBe(1);
    expect(summary.summary.deleted).toBe(1);
    expect(summary.summary.renamed).toBe(1);
    expect(summary.dirty).toBe(true);
  });
});

describe('getGitChangesSummary — counts + truncation', () => {
  test('counts reflect all files; the file list is capped with truncation metadata', () => {
    const repo = makeRepo('vibecode-gcs-trunc-');
    for (let i = 0; i < 5; i += 1) write(repo, `src/f${i}.ts`, `${i}\n`);

    const summary = getGitChangesSummary(repo, { maxFiles: 2 });
    expect(summary.total_changed).toBe(5);
    expect(summary.returned_changed).toBe(2);
    expect(summary.files).toHaveLength(2);
    expect(summary.truncated).toBe(true);
    // Counts are computed over ALL changed files, not just the returned slice.
    expect(summary.summary.changed_count).toBe(5);
    expect(summary.summary.untracked).toBe(5);
  });

  test('a small change set is not truncated', () => {
    const repo = makeRepo('vibecode-gcs-notrunc-');
    write(repo, 'src/a.ts');
    const summary = getGitChangesSummary(repo, { maxFiles: 50 });
    expect(summary.truncated).toBe(false);
    expect(summary.returned_changed).toBe(1);
  });

  test('defensive cap: rejects max_files above hard max', () => {
    const repo = makeRepo('vibecode-gcs-cap-reject-');
    write(repo, 'src/a.ts');
    expect(() => getGitChangesSummary(repo, { maxFiles: 201 })).toThrow(/exceeds maximum/);
  });

  test('defensive cap: accepts max_files at hard max (200)', () => {
    const repo = makeRepo('vibecode-gcs-cap-boundary-');
    write(repo, 'src/a.ts');
    const summary = getGitChangesSummary(repo, { maxFiles: 200 });
    expect(summary.ok).toBe(true);
    expect(summary.returned_changed).toBe(1);
  });
});

describe('getGitChangesSummary — diff stat', () => {
  test('includes a bounded diff stat by default but not a full diff', () => {
    const repo = makeRepo('vibecode-gcs-diff-');
    write(repo, 'src/a.ts', 'one\n');
    commit(repo, 'seed');
    write(repo, 'src/a.ts', 'one\ntwo\nthree\n');

    const summary = getGitChangesSummary(repo);
    expect(summary.diff_stat).toBeTypeOf('string');
    expect(summary.diff_stat).toContain('src/a.ts');
    // A --stat summary never includes hunk headers / patch bodies.
    expect(summary.diff_stat).not.toContain('@@');
  });

  test('diff stat can be disabled', () => {
    const repo = makeRepo('vibecode-gcs-nodiff-');
    write(repo, 'src/a.ts', 'one\n');
    commit(repo, 'seed');
    write(repo, 'src/a.ts', 'one\ntwo\n');
    const summary = getGitChangesSummary(repo, { includeDiffStat: false });
    expect(summary.diff_stat).toBeNull();
  });
});

describe('getGitChangesSummary — classification', () => {
  test('without agent_id, non-generated files are unknown_without_agent_id with a warning', () => {
    const repo = makeRepo('vibecode-gcs-noagent-');
    write(repo, 'src/a.ts');

    const summary = getGitChangesSummary(repo);
    expect(summary.agent_id).toBeNull();
    expect(fileOf(summary, 'src/a.ts').classification).toBe('unknown_without_agent_id');
    expect(summary.warnings.some((w) => w.code === 'NO_AGENT_ID')).toBe(true);
    expect(summary.summary.unknown_without_agent_id).toBe(1);
  });

  test('with agent_id, files are classified against active claims', () => {
    const repo = makeRepo('vibecode-gcs-agent-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/theirs.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/theirs.ts');
    write(repo, 'src/loose.ts');

    const summary = getGitChangesSummary(repo, { agent_id: a.agent_id });
    expect(summary.agent_id).toBe(a.agent_id);
    expect(fileOf(summary, 'src/mine.ts').classification).toBe('claimed_by_agent');
    expect(fileOf(summary, 'src/mine.ts').owning_agent_id).toBe(a.agent_id);
    expect(fileOf(summary, 'src/theirs.ts').classification).toBe('claimed_by_other_active_agent');
    expect(fileOf(summary, 'src/theirs.ts').owning_agent_id).toBe(b.agent_id);
    expect(fileOf(summary, 'src/loose.ts').classification).toBe('unclaimed');

    expect(summary.summary.claimed_by_agent).toBe(1);
    expect(summary.summary.claimed_by_other_active_agent).toBe(1);
    expect(summary.summary.unclaimed).toBe(1);
  });

  test('staged_unclaimed counts unclaimed files already staged in the index (Phase 3B)', () => {
    const repo = makeRepo('vibecode-gcs-stagedunclaimed-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/loose-staged.ts');
    write(repo, 'src/loose-unstaged.ts');
    git(['add', '--', 'src/loose-staged.ts'], repo);

    const summary = getGitChangesSummary(repo, { agent_id: a.agent_id });
    expect(summary.summary.unclaimed).toBe(2);
    // Only the staged unclaimed file is counted — this feeds the Phase 3B
    // commit-guard preflight (staged unclaimed files hard-block the guard).
    expect(summary.summary.staged_unclaimed).toBe(1);
  });

  test('staged_unclaimed is zero when only claimed files are staged', () => {
    const repo = makeRepo('vibecode-gcs-stagedclaimed-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    git(['add', '--', 'src/mine.ts'], repo);

    const summary = getGitChangesSummary(repo, { agent_id: a.agent_id });
    expect(summary.summary.claimed_by_agent).toBe(1);
    expect(summary.summary.staged_unclaimed).toBe(0);
  });

  test('staged_claimed_by_other_agent counts other-agent claimed files already staged (commit guard GIT_INDEX_NOT_CLEAN mirror)', () => {
    const repo = makeRepo('vibecode-gcs-stagedother-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/theirs.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/theirs.ts');
    git(['add', '--', 'src/theirs.ts'], repo);

    const summary = getGitChangesSummary(repo, { agent_id: a.agent_id });
    expect(summary.summary.claimed_by_other_active_agent).toBe(1);
    // The other agent's staged file is not unclaimed, but the commit guard
    // still blocks on it at index verification (GIT_INDEX_NOT_CLEAN).
    expect(summary.summary.staged_unclaimed).toBe(0);
    expect(summary.summary.staged_claimed_by_other_agent).toBe(1);
  });

  test('staged_claimed_by_other_agent is zero when only own claimed files are staged', () => {
    const repo = makeRepo('vibecode-gcs-stagedown-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    git(['add', '--', 'src/mine.ts'], repo);

    const summary = getGitChangesSummary(repo, { agent_id: a.agent_id });
    expect(summary.summary.staged_claimed_by_other_agent).toBe(0);
  });

  test('unclaimed dirty source files produce a HIGH warning when an agent is supplied', () => {
    const repo = makeRepo('vibecode-gcs-unclaimed-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    write(repo, 'src/loose.ts');

    const summary = getGitChangesSummary(repo, { agent_id: a.agent_id });
    const warn = summary.warnings.find((w) => w.code === 'UNCLAIMED_DIRTY_FILES');
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe('high');
  });

  test('generated/ignored runtime paths are classified separately and never unclaimed', () => {
    const repo = makeRepo('vibecode-gcs-generated-', { gitignoreVibecode: false });
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    write(repo, path.join('.vibecode', 'coordination', 'state.json'), '{}\n');

    const summary = getGitChangesSummary(repo, { agent_id: a.agent_id });
    expect(fileOf(summary, '.vibecode/coordination/state.json').classification).toBe('generated_or_ignored');
    expect(summary.summary.generated_or_ignored).toBe(1);
    expect(summary.summary.unclaimed).toBe(0);
    // A purely-generated change set must not raise the unclaimed HIGH warning.
    expect(summary.warnings.some((w) => w.code === 'UNCLAIMED_DIRTY_FILES')).toBe(false);
  });

  test('a path overlapping only a stale claim is classified stale_claim_overlap', () => {
    const T0 = '2026-01-01T00:00:00.000Z';
    const T_LATER = '2026-01-01T01:00:00.000Z';
    const repo = makeRepo('vibecode-gcs-stale-');
    const stale = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0 });
    addFileClaim(repo, { agent_id: stale.agent_id, path: 'src/s.ts', mode: 'exclusive' }, { now: T0 });
    const active = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_LATER });
    write(repo, 'src/s.ts');

    const summary = getGitChangesSummary(repo, { agent_id: active.agent_id, now: T_LATER });
    expect(fileOf(summary, 'src/s.ts').classification).toBe('stale_claim_overlap');
    expect(summary.summary.stale_claim_overlap).toBe(1);
  });
});

describe('getGitChangesSummary — safety', () => {
  test('a non-git directory yields a structured failure with warnings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-gcs-nogit-'));
    const summary = getGitChangesSummary(dir);
    expect(summary.ok).toBe(false);
    expect(summary.warnings.length).toBeGreaterThan(0);
    expect(summary.files).toEqual([]);
  });

  test('does not mutate git or source state', () => {
    const repo = makeRepo('vibecode-gcs-nomutate-');
    write(repo, 'src/a.ts');
    git(['add', '--', 'src/a.ts'], repo);
    const headBefore = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    const statusBefore = git(['status', '--porcelain=v1'], repo).stdout;

    getGitChangesSummary(repo);

    expect(git(['rev-parse', 'HEAD'], repo).stdout.trim()).toBe(headBefore);
    expect(git(['status', '--porcelain=v1'], repo).stdout).toBe(statusBefore);
  });
});
