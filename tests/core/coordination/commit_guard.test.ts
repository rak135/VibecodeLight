import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import { runCommitGuard, type CommitGuardResult } from '../../../src/core/coordination/commit_guard.js';
import type { GitCommandRunner, GitCommandResult } from '../../../src/core/workspace/git_commit.js';
import { defaultGitCommandRunner } from '../../../src/core/workspace/git_commit.js';
import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim, releaseFileClaim } from '../../../src/core/coordination/claims.js';
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const before = head(repo);
    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('NO_COMMITTABLE_FILES');
    expect(result.commit_hash).toBeNull();
    expect(head(repo)).toBe(before);
  });

  test('finalize blocked (unclaimed file) → commit denied, no commit created', () => {
    const repo = makeRepo('vibecode-cg-unclaimed-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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

  test('file claimed by another active agent (no own claims) → commit denied NO_COMMITTABLE_FILES', () => {
    const repo = makeRepo('vibecode-cg-other-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/b.ts', mode: 'exclusive' });
    write(repo, 'src/b.ts');
    const before = head(repo);
    const result = runCommitGuard({ repoRoot: repo, agent_id: a.agent_id });
    expect(result.status).toBe('blocked');
    expect(result.finalize_check.status).toBe('warning');
    expect(result.blocks.map((b) => b.code)).toContain('NO_COMMITTABLE_FILES');
    expect(head(repo)).toBe(before);
  });

  test('non-overlapping parallel: Agent A commits only its claimed file while Agent B file remains dirty', () => {
    const repo = makeRepo('vibecode-cg-parallel-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/alpha.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/beta.ts', mode: 'exclusive' });
    write(repo, 'src/alpha.ts', 'alpha\n');
    write(repo, 'src/beta.ts', 'beta\n');
    const before = head(repo);

    const resultA = runCommitGuard({ repoRoot: repo, agent_id: a.agent_id });
    expect(resultA.status).toBe('committed');
    expect(resultA.committed_files).toEqual(['src/alpha.ts']);
    expect(resultA.commit_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(resultA.commit_hash).not.toBe(before);
    expect(resultA.skipped_files.find((f) => f.path === 'src/beta.ts')?.reason).toBe('claimed_by_other_agent');

    // Commit contains only src/alpha.ts
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['src/alpha.ts']);

    // src/beta.ts remains dirty
    expect(porcelain(repo)).toContain('src/beta.ts');

    // Agent B can now commit src/beta.ts
    const resultB = runCommitGuard({ repoRoot: repo, agent_id: b.agent_id });
    expect(resultB.status).toBe('committed');
    expect(resultB.committed_files).toEqual(['src/beta.ts']);
    expect(resultB.commit_hash).not.toBe(resultA.commit_hash);

    // Both committed, clean tree
    const finalPorcelain = porcelain(repo);
    expect(finalPorcelain).not.toContain('src/alpha.ts');
    expect(finalPorcelain).not.toContain('src/beta.ts');
  });
});

describe('runCommitGuard — scoped staging and commit', () => {
  test('dry-run lists would-stage files but does not stage or commit', () => {
    const repo = makeRepo('vibecode-cg-dry-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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

  test('a pathspec-metacharacter filename is staged literally', () => {
    const repo = makeRepo('vibecode-cg-literal-');
    write(repo, 'src/a.ts', 'tracked\n');
    git(['add', '--', 'src/a.ts'], repo);
    git(['commit', '-q', '-m', 'track a'], repo);

    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/[abc].ts', mode: 'exclusive' });
    write(repo, 'src/[abc].ts');

    const invoked: string[][] = [];
    const recordingRunner: GitCommandRunner = (args, cwd): GitCommandResult => {
      invoked.push(args);
      return defaultGitCommandRunner(args, cwd);
    };

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, gitRunner: recordingRunner });
    expect(result.status).toBe('committed');
    const addArgs = invoked.find((args) => args[0] === 'add');
    expect(addArgs).toContain('--');
    expect(addArgs).toContain(':(literal)src/[abc].ts');

    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['src/[abc].ts']);
  });

  test('commit message includes Vibecode-Run / Vibecode-Agent metadata footer', () => {
    const repo = makeRepo('vibecode-cg-msg-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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

  test('dry-run with run_id does not write commit_guard.json', () => {
    const repo = makeRepo('vibecode-cg-dry-artifact-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    writeAgentBinding(path.join(getWorkspacePaths(repo).runs, 'run1'), {
      agent_id: agent.agent_id,
      terminal_session_id: null,
      agent_mode: 'cli',
      coordination_enabled: true,
    });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = runCommitGuard({ repoRoot: repo, run_id: 'run1', dry_run: true });
    expect(result.status).toBe('dry_run');
    const artifact = path.join(getWorkspacePaths(repo).runs, 'run1', 'coordination', 'commit_guard.json');
    expect(fs.existsSync(artifact)).toBe(false);
  });

  test('invalid (whitespace-only) message is an invocation error and commits nothing', () => {
    const repo = makeRepo('vibecode-cg-badmsg-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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

  test('invalid traversal run_id is rejected and writes no outside artifact', () => {
    const repo = makeRepo('vibecode-cg-badrun-');
    const outside = path.resolve(getWorkspacePaths(repo).runs, '../../outside');

    const result = runCommitGuard({ repoRoot: repo, run_id: '../../outside' });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('INVALID_RUN_ID');
    expect(fs.existsSync(outside)).toBe(false);
  });

  test('absolute run_id is rejected and writes no outside artifact', () => {
    const repo = makeRepo('vibecode-cg-absrun-');
    const absoluteRunId = path.resolve(path.dirname(repo), 'outside-run');

    const result = runCommitGuard({ repoRoot: repo, run_id: absoluteRunId });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('INVALID_RUN_ID');
    expect(fs.existsSync(absoluteRunId)).toBe(false);
  });

  test('staged-file listing failure at entry blocks before staging', () => {
    const repo = makeRepo('vibecode-cg-entry-list-fail-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    const before = head(repo);
    const invoked: string[][] = [];
    const failingRunner: GitCommandRunner = (args, cwd): GitCommandResult => {
      invoked.push(args);
      if (args[0] === 'diff') return { ok: false, stdout: '', stderr: 'index unavailable', exitCode: 1 };
      return defaultGitCommandRunner(args, cwd);
    };

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, gitRunner: failingRunner });

    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('GIT_STAGED_FILES_FAILED');
    expect(invoked.some((args) => args[0] === 'add')).toBe(false);
    expect(invoked.some((args) => args[0] === 'commit')).toBe(false);
    expect(head(repo)).toBe(before);
  });

  test('staged-file listing failure after staging blocks before commit', () => {
    const repo = makeRepo('vibecode-cg-post-list-fail-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    const before = head(repo);
    let listCalls = 0;
    const invoked: string[][] = [];
    const failingRunner: GitCommandRunner = (args, cwd): GitCommandResult => {
      invoked.push(args);
      if (args[0] === 'diff') {
        listCalls += 1;
        return listCalls === 1
          ? { ok: true, stdout: '', stderr: '', exitCode: 0 }
          : { ok: false, stdout: '', stderr: 'index unavailable', exitCode: 1 };
      }
      return defaultGitCommandRunner(args, cwd);
    };

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, gitRunner: failingRunner });

    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('GIT_STAGED_FILES_FAILED');
    expect(invoked.some((args) => args[0] === 'add')).toBe(true);
    expect(invoked.some((args) => args[0] === 'commit')).toBe(false);
    expect(head(repo)).toBe(before);
  });

  test('post-stage mismatch blocks before commit', () => {
    const repo = makeRepo('vibecode-cg-post-mismatch-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    const before = head(repo);
    let listCalls = 0;
    const invoked: string[][] = [];
    const mismatchRunner: GitCommandRunner = (args, cwd): GitCommandResult => {
      invoked.push(args);
      if (args[0] === 'diff') {
        listCalls += 1;
        return {
          ok: true,
          stdout: listCalls === 1 ? '' : 'src/a.ts\0src/extra.ts\0',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'add') return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      return defaultGitCommandRunner(args, cwd);
    };

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, gitRunner: mismatchRunner });

    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('GIT_STATUS_CHANGED_DURING_COMMIT');
    expect(invoked.some((args) => args[0] === 'commit')).toBe(false);
    expect(head(repo)).toBe(before);
  });
});

describe('runCommitGuard — Phase 3A isolated commit in a shared dirty tree', () => {
  test('dogfood scenario: dry-run allows an isolated commit and warns about the skipped unclaimed dirty file', () => {
    const repo = makeRepo('vibecode-cg-iso-dry-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'claimed/file.ts', mode: 'exclusive' });
    write(repo, 'claimed/file.ts', 'mine\n');
    write(repo, 'unclaimed/other-wip.ts', 'foreign wip\n');
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id, dry_run: true });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('dry_run');
    expect(result.isolated_commit).toBe(true);
    expect(result.staged_files).toEqual(['claimed/file.ts']);
    expect(result.skipped_files).toEqual([{ path: 'unclaimed/other-wip.ts', reason: 'unclaimed' }]);
    expect(result.warnings.map((w) => w.code)).toContain('UNCLAIMED_DIRTY_FILES_SKIPPED');
    // Finalize itself stays conservative: it still reports the unclaimed blocker.
    expect(result.finalize_check.status).toBe('blocked');
    expect(result.finalize_check.blocks.map((b) => b.code)).toContain('UNCLAIMED_CHANGED_FILE');
    // Nothing staged, nothing committed.
    expect(head(repo)).toBe(before);
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('');
  });

  test('dogfood scenario: real commit commits only the claimed file and leaves the unclaimed file dirty and untouched', () => {
    const repo = makeRepo('vibecode-cg-iso-commit-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'claimed/file.ts', mode: 'exclusive' });
    write(repo, 'claimed/file.ts', 'mine\n');
    write(repo, 'unclaimed/other-wip.ts', 'foreign wip\n');
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });

    expect(result.status).toBe('committed');
    expect(result.isolated_commit).toBe(true);
    expect(result.committed_files).toEqual(['claimed/file.ts']);
    expect(result.commit_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit_hash).not.toBe(before);
    expect(result.warnings.map((w) => w.code)).toContain('UNCLAIMED_DIRTY_FILES_SKIPPED');

    // The commit contains ONLY the claimed file.
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['claimed/file.ts']);

    // The unclaimed file is still dirty, unstaged, and byte-identical.
    expect(porcelain(repo)).toContain('unclaimed/other-wip.ts');
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(repo, 'unclaimed/other-wip.ts'), 'utf8')).toBe('foreign wip\n');
  });

  test('multiple claimed files commit together while the unclaimed file is skipped', () => {
    const repo = makeRepo('vibecode-cg-iso-multi-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/one.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/two.ts', mode: 'exclusive' });
    write(repo, 'src/one.ts');
    write(repo, 'src/two.ts');
    write(repo, 'wip/unrelated.ts');

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });

    expect(result.status).toBe('committed');
    expect(result.isolated_commit).toBe(true);
    expect([...result.committed_files].sort()).toEqual(['src/one.ts', 'src/two.ts']);
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .sort();
    expect(committed).toEqual(['src/one.ts', 'src/two.ts']);
    expect(porcelain(repo)).toContain('wip/unrelated.ts');
  });

  test('an other-agent claimed dirty file is skipped (never staged or committed) alongside an unclaimed file', () => {
    const repo = makeRepo('vibecode-cg-iso-other-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/theirs.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/theirs.ts');
    write(repo, 'wip/unclaimed.ts');

    const result = runCommitGuard({ repoRoot: repo, agent_id: a.agent_id });

    expect(result.status).toBe('committed');
    expect(result.committed_files).toEqual(['src/mine.ts']);
    expect(result.skipped_files).toContainEqual({ path: 'src/theirs.ts', reason: 'claimed_by_other_agent' });
    expect(result.skipped_files).toContainEqual({ path: 'wip/unclaimed.ts', reason: 'unclaimed' });
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).stdout
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(committed).toEqual(['src/mine.ts']);
    expect(porcelain(repo)).toContain('src/theirs.ts');
    expect(porcelain(repo)).toContain('wip/unclaimed.ts');
  });

  test('a staged unclaimed dirty file blocks with STAGED_UNCLAIMED_FILES_BLOCKED and stays staged', () => {
    const repo = makeRepo('vibecode-cg-iso-staged-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    write(repo, 'wip/staged-foreign.ts');
    git(['add', '--', 'wip/staged-foreign.ts'], repo);
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });

    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('STAGED_UNCLAIMED_FILES_BLOCKED');
    expect(head(repo)).toBe(before);
    // The guard never unstages or modifies the foreign file.
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('wip/staged-foreign.ts');
  });

  test('a staged other-agent claimed file blocks before any staging', () => {
    const repo = makeRepo('vibecode-cg-iso-staged-other-');
    const a = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const b = registerAgent(repo, { agent_name: 'B', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: a.agent_id, path: 'src/mine.ts', mode: 'exclusive' });
    addFileClaim(repo, { agent_id: b.agent_id, path: 'src/theirs.ts', mode: 'exclusive' });
    write(repo, 'src/mine.ts');
    write(repo, 'src/theirs.ts');
    git(['add', '--', 'src/theirs.ts'], repo);
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: a.agent_id });

    expect(result.status).toBe('blocked');
    expect(result.blocks.map((b) => b.code)).toContain('GIT_INDEX_NOT_CLEAN');
    expect(head(repo)).toBe(before);
    expect(git(['diff', '--cached', '--name-only'], repo).stdout.trim()).toBe('src/theirs.ts');
  });

  test('a pre-staged current-agent claimed file in the commit set is allowed', () => {
    const repo = makeRepo('vibecode-cg-iso-prestaged-own-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');
    git(['add', '--', 'src/a.ts'], repo);
    write(repo, 'wip/unrelated.ts');

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });

    expect(result.status).toBe('committed');
    expect(result.committed_files).toEqual(['src/a.ts']);
    expect(porcelain(repo)).toContain('wip/unrelated.ts');
  });

  test('a released claim no longer authorizes an isolated commit', () => {
    const repo = makeRepo('vibecode-cg-iso-released-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    const { claim } = addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    if (!claim) throw new Error('test setup: claim was not created');
    write(repo, 'src/a.ts');
    releaseFileClaim(repo, claim.claim_id);
    const before = head(repo);

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });

    expect(result.status).toBe('blocked');
    expect(result.isolated_commit).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain('FINALIZE_CHECK_BLOCKED');
    expect(head(repo)).toBe(before);
  });

  test('a non-git directory blocks fail-closed (no isolated commit without readable git status)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cg-iso-nogit-'));
    const agent = registerAgent(root, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(root, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'x\n', 'utf8');

    const result = runCommitGuard({ repoRoot: root, agent_id: agent.agent_id });

    expect(result.status).toBe('blocked');
    expect(result.isolated_commit).toBe(false);
    expect(result.blocks.map((b) => b.code)).toContain('FINALIZE_CHECK_BLOCKED');
    expect(result.finalize_check.blocks.map((b) => b.code)).toContain('GIT_CHANGED_FILES_FAILED');
  });

  test('a normal clean scoped commit reports isolated_commit=false and no skip warning', () => {
    const repo = makeRepo('vibecode-cg-iso-normal-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
    addFileClaim(repo, { agent_id: agent.agent_id, path: 'src/a.ts', mode: 'exclusive' });
    write(repo, 'src/a.ts');

    const result = runCommitGuard({ repoRoot: repo, agent_id: agent.agent_id });

    expect(result.status).toBe('committed');
    expect(result.isolated_commit).toBe(false);
    expect(result.warnings.map((w) => w.code)).not.toContain('UNCLAIMED_DIRTY_FILES_SKIPPED');
  });
});

describe('runCommitGuard — git command safety', () => {
  test('never invokes git add -A / add . / reset / stash / clean / checkout / restore', () => {
    const repo = makeRepo('vibecode-cg-safe-');
    const agent = registerAgent(repo, { agent_name: 'A', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } });
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
        expect(args.some((arg) => arg.startsWith(':(literal)'))).toBe(true);
      }
    }
  });
});
