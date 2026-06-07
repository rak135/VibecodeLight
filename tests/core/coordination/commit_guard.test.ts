import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { runCommitGuard, type CommitGuardResult } from '../../../src/core/coordination/commit_guard.js';
import type { GitCommandRunner, GitCommandResult } from '../../../src/core/workspace/git_commit.js';
import { defaultGitCommandRunner } from '../../../src/core/workspace/git_commit.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import { writeAgentBinding } from '../../../src/core/coordination/agent_binding.js';
import { getWorkspacePaths } from '../../../src/core/workspace/paths.js';

/**
 * Phase 4B commit guard — exercised against REAL git working trees. This is the
 * first git-mutating coordination phase, so the tests pin the safety contract
 * directly: only claimed files are committed, the index must be clean at entry,
 * `git add -A` is never used, and nothing is reset/stashed.
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
  git(['config', 'core.quotepath', 'false'], repo);
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

function head(repo: string): string {
  return git(['rev-parse', 'HEAD'], repo).stdout.trim();
}

function porcelain(repo: string): string {
  return git(['status', '--porcelain=v1', '--untracked-files=all'], repo).stdout;
}

describe('runCommitGuard — gating on finalize check', () => {
  test('clean tree → blocked NO_COMMITTABLE_FILES (nothing committed)', () => {
    const repo = makeRepo('vibecode-cg-clean-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    const before = head(repo);
    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('NO_COMMITTABLE_FILES');
    expect(result.commit_hash).toBeNull();
    expect(head(repo)).toBe(before);
  });

  test('finalize blocked (unclaimed file) → commit denied, no commit created', () => {
    const repo = makeRepo('vibecode-cg-unclaimed-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    write(repo, 'src/a.ts');
    const before = head(repo);
    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('FINALIZE_CHECK_BLOCKED');
    expect(result.finalize_check.status).toBe('blocked');
    expect(head(repo)).toBe(before);
    // The dirty file remains untracked / untouched.
    expect(porcelain(repo)).toContain('src/a.ts');
  });

  test('file claimed by another active agent → commit denied', () => {
    const repo = makeRepo('vibecode-cg-other-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/b.ts', mode: 'exclusive' });
    write(repo, 'src/b.ts');
    const before = head(repo);
    const result = runCommitGuard({ repoRoot: repo, agent_id: a.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.finalize_check.status).toBe('blocked');
    expect(head(repo)).toBe(before);
  });
});

describe('runCommitGuard — scoped staging and commit', () => {
  test('dry-run lists would-stage files but does not stage or commit', () => {
    const repo = makeRepo('vibecode-cg-dry-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, dry_run: true });
    expect(result.status).toBe('dry_run');
    expect(result.staged_files).toEqual(['src/a.ts']);
    expect(result.committed_files).toEqual([]);
    expect(result.commit_hash).toBeNull();
    expect(head(repo)).toBe(before);
    // Nothing staged in real git.
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('');
  });

  test('commits exactly the claimed file and leaves generated/unrelated files untouched', () => {
    const repo = makeRepo('vibecode-cg-commit-', { gitignoreVibecode: false });
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    // A generated runtime change that must never be staged.
    write(repo, path.join('.vibecode', 'note.txt'), 'generated\n');
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('committed');
    expect(result.committed_files).toEqual(['src/a.ts']);
    expect(result.commit_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit_hash).not.toBe(before);
    expect(head(repo)).toBe(result.commit_hash);

    // Commit contains only src/a.ts.
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['src/a.ts']);

    // The generated file was never staged and remains present (untouched).
    expect(result.skipped_files.find((f) => f.path === '.vibecode/note.txt')?.reason).toBe('generated_or_ignored');
    expect(fs.existsSync(path.join(repo, '.vibecode', 'note.txt'))).toBe(true);
    expect(porcelain(repo)).toContain('.vibecode/note.txt');
  });

  test('a file path with spaces is staged and committed safely', () => {
    const repo = makeRepo('vibecode-cg-spaces-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a b.ts', mode: 'exclusive' });
    write(repo, 'src/a b.ts');

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('committed');
    expect(result.committed_files).toEqual(['src/a b.ts']);
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['src/a b.ts']);
  });

  test('commit message includes Vibecode-Run / Vibecode-Agent metadata footer', () => {
    const repo = makeRepo('vibecode-cg-msg-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    writeAgentBinding(path.join(getWorkspacePaths(repo).runs, 'run1'), {
      agent_id: agent.agent_id,
      terminal_session_id: null,
      agent_mode: 'cli',
      coordination_enabled: true,
    });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = runCommitGuard({ repoRoot: repo, run_id: 'run1', message: 'feat(x): my change' });
    expect(result.status).toBe('committed');
    const body = git(['log', '-1', '--format=%B'], repo).stdout;
    expect(body).toContain('feat(x): my change');
    expect(body).toContain(`Vibecode-Run: run1`);
    expect(body).toContain(`Vibecode-Agent: ${agent.agent_id}`);
  });

  test('writes a commit_guard.json artifact under the run when run_id is provided', () => {
    const repo = makeRepo('vibecode-cg-artifact-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    writeAgentBinding(path.join(getWorkspacePaths(repo).runs, 'run1'), {
      agent_id: agent.agent_id,
      terminal_session_id: null,
      agent_mode: 'cli',
      coordination_enabled: true,
    });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = runCommitGuard({ repoRoot: repo, run_id: 'run1' });
    expect(result.status).toBe('committed');
    const artifact = path.join(getWorkspacePaths(repo).runs, 'run1', 'coordination', 'commit_guard.json');
    expect(fs.existsSync(artifact)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(artifact, 'utf8')) as { status: string; commit_hash: string };
    expect(parsed.status).toBe('committed');
    expect(parsed.commit_hash).toBe(result.commit_hash);
  });

  test('invalid (whitespace-only) message is an invocation error and commits nothing', () => {
    const repo = makeRepo('vibecode-cg-badmsg-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, message: '   ' });
    expect(result.ok).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain('INVALID_COMMIT_MESSAGE');
    expect(head(repo)).toBe(before);
  });
});

describe('runCommitGuard — index safety', () => {
  test('pre-existing unrelated staged file blocks with GIT_INDEX_NOT_CLEAN', () => {
    const repo = makeRepo('vibecode-cg-dirtyindex-', { gitignoreVibecode: false });
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    // A stray staged generated file that is NOT in the committable set.
    write(repo, path.join('.vibecode', 'stray.txt'), 'stray\n');
    git(['add', '--', '.vibecode/stray.txt'], repo);
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('GIT_INDEX_NOT_CLEAN');
    expect(head(repo)).toBe(before);
  });
});

describe('runCommitGuard — git command safety', () => {
  test('never invokes git add -A / add . / reset / stash / clean / checkout / restore', () => {
    const repo = makeRepo('vibecode-cg-safe-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const invoked: string[][] = [];
    const recordingRunner: GitCommandRunner = (args, cwd): GitCommandResult => {
      invoked.push(args);
      return defaultGitCommandRunner(args, cwd);
    };

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, gitRunner: recordingRunner });
    expect(result.status).toBe('committed');
    expect(invoked.length).toBeGreaterThan(0);

    const forbiddenFirst = ['reset', 'stash', 'clean', 'checkout', 'restore'];
    for (const args of invoked) {
      expect(forbiddenFirst).not.toContain(args[0]);
      // No broad staging.
      expect(args.join(' ')).not.toContain('add -A');
      expect(args.join(' ')).not.toContain('add .');
      if (args[0] === 'add') {
        // Every stage must use an explicit `--` pathspec separator.
        expect(args).toContain('--');
        expect(args).not.toContain('-A');
        expect(args).not.toContain('.');
      }
    }
  });
});
