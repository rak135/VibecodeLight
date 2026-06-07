import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test } from 'vitest';

import {
  getGitChangedFiles,
  parsePorcelainZ,
  isGeneratedOrIgnoredRuntimePath,
  type GitChangedFile,
  type GitChangedFilesOutcome,
} from '../../../src/core/workspace/git_changed_files.js';
import {
  defaultGitReadOnlyRunner,
  type GitReadOnlyRunner,
  type GitReadOnlyRunResult,
} from '../../../src/core/workspace/git_status.js';

/**
 * Real-git fixture helpers. We deliberately exercise the adapter against real
 * `git status --porcelain=v1 -z` output (paths with spaces, nested paths,
 * renames) rather than only hand-crafted strings, because the porcelain `-z`
 * rename byte order is the kind of detail that is easy to get self-consistently
 * wrong in both parser and unit fixture.
 */
function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Path deliberately contains a space to prove repo_root + paths survive it.
  const repo = path.join(root, 'repo with spaces');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  return repo;
}

function write(repo: string, rel: string, content: string): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function commitFile(repo: string, rel: string, content: string): void {
  write(repo, rel, content);
  git(['add', '--', rel], repo);
  git(['commit', '-q', '-m', `add ${rel}`], repo);
}

function expectOk(outcome: GitChangedFilesOutcome) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`expected ok outcome, got warnings: ${outcome.warnings.join(', ')}`);
  return outcome;
}

function fileFor(files: GitChangedFile[], p: string): GitChangedFile {
  const found = files.find((f) => f.path === p);
  if (!found) throw new Error(`no changed file for ${p}; got ${files.map((f) => f.path).join(', ')}`);
  return found;
}

describe('getGitChangedFiles (real git fixtures)', () => {
  test('clean repo returns no changed files but a real HEAD', () => {
    const repo = makeRepo('vibecode-gcf-clean-');
    const result = expectOk(getGitChangedFiles(repo));
    expect(result.files).toEqual([]);
    expect(result.raw_count).toBe(0);
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(result.repo_root).not.toContain('\\');
  });

  test('unstaged modified file is modified + unstaged only', () => {
    const repo = makeRepo('vibecode-gcf-modunstaged-');
    commitFile(repo, 'a.txt', 'one\n');
    write(repo, 'a.txt', 'one\ntwo\n');
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'a.txt');
    expect(f.status).toBe('modified');
    expect(f.unstaged).toBe(true);
    expect(f.staged).toBe(false);
    expect(f.untracked).toBe(false);
  });

  test('staged modified file is modified + staged only', () => {
    const repo = makeRepo('vibecode-gcf-modstaged-');
    commitFile(repo, 'a.txt', 'one\n');
    write(repo, 'a.txt', 'one\ntwo\n');
    git(['add', '--', 'a.txt'], repo);
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'a.txt');
    expect(f.status).toBe('modified');
    expect(f.staged).toBe(true);
    expect(f.unstaged).toBe(false);
  });

  test('staged new file is added + staged', () => {
    const repo = makeRepo('vibecode-gcf-added-');
    write(repo, 'new.txt', 'hi\n');
    git(['add', '--', 'new.txt'], repo);
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'new.txt');
    expect(f.status).toBe('added');
    expect(f.staged).toBe(true);
    expect(f.untracked).toBe(false);
  });

  test('untracked file is untracked', () => {
    const repo = makeRepo('vibecode-gcf-untracked-');
    write(repo, 'loose.txt', 'hi\n');
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'loose.txt');
    expect(f.status).toBe('untracked');
    expect(f.untracked).toBe(true);
    expect(f.staged).toBe(false);
    expect(f.unstaged).toBe(false);
  });

  test('deleted (unstaged) tracked file is deleted', () => {
    const repo = makeRepo('vibecode-gcf-deleted-');
    commitFile(repo, 'gone.txt', 'bye\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'gone.txt');
    expect(f.status).toBe('deleted');
    expect(f.unstaged).toBe(true);
  });

  test('renamed file preserves original_path', () => {
    const repo = makeRepo('vibecode-gcf-renamed-');
    commitFile(repo, 'old name.txt', 'content for rename detection here\n');
    git(['mv', 'old name.txt', 'new name.txt'], repo);
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'new name.txt');
    expect(f.status).toBe('renamed');
    expect(f.original_path).toBe('old name.txt');
    expect(f.staged).toBe(true);
  });

  test('file modified in both index and worktree is staged AND unstaged', () => {
    const repo = makeRepo('vibecode-gcf-both-');
    commitFile(repo, 'a.txt', 'one\n');
    write(repo, 'a.txt', 'one\ntwo\n');
    git(['add', '--', 'a.txt'], repo);
    write(repo, 'a.txt', 'one\ntwo\nthree\n');
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'a.txt');
    expect(f.staged).toBe(true);
    expect(f.unstaged).toBe(true);
    expect(f.status).toBe('modified');
  });

  test('path with spaces parses correctly', () => {
    const repo = makeRepo('vibecode-gcf-spaces-');
    write(repo, 'a file with spaces.txt', 'hi\n');
    const result = expectOk(getGitChangedFiles(repo));
    expect(result.files.map((f) => f.path)).toContain('a file with spaces.txt');
  });

  test('nested path is normalized with forward slashes', () => {
    const repo = makeRepo('vibecode-gcf-nested-');
    write(repo, path.join('src', 'deep', 'thing.ts'), 'export const x = 1;\n');
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, 'src/deep/thing.ts');
    expect(f.path).toBe('src/deep/thing.ts');
    expect(f.path).not.toContain('\\');
  });

  test('.vibecode/ runtime artifact is detected and classified as generated', () => {
    const repo = makeRepo('vibecode-gcf-vibecode-');
    write(repo, path.join('.vibecode', 'changed.json'), '{}\n');
    const result = expectOk(getGitChangedFiles(repo));
    const f = fileFor(result.files, '.vibecode/changed.json');
    expect(f.status).toBe('untracked');
    expect(isGeneratedOrIgnoredRuntimePath(f.path)).toBe(true);
  });

  test('repo with no commits is handled gracefully (head null)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-gcf-nocommit-'));
    const repo = path.join(root, 'fresh');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q'], repo);
    write(repo, 'first.txt', 'hi\n');
    const result = expectOk(getGitChangedFiles(repo));
    expect(result.head).toBeNull();
    expect(result.files.map((f) => f.path)).toContain('first.txt');
  });

  test('non-git directory returns a structured failure (no throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-gcf-nogit-'));
    const outcome = getGitChangedFiles(dir);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.warnings.length).toBeGreaterThan(0);
      expect(outcome.warnings.some((w) => /git/i.test(w))).toBe(true);
    }
  });
});

describe('getGitChangedFiles does not mutate git state', () => {
  test('HEAD and porcelain status are unchanged after the call', () => {
    const repo = makeRepo('vibecode-gcf-nomutate-');
    commitFile(repo, 'a.txt', 'one\n');
    write(repo, 'a.txt', 'one\ntwo\n');
    write(repo, 'untracked.txt', 'x\n');
    git(['add', '--', 'untracked.txt'], repo);

    const headBefore = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    const statusBefore = git(['status', '--porcelain=v1'], repo).stdout;

    getGitChangedFiles(repo);

    const headAfter = git(['rev-parse', 'HEAD'], repo).stdout.trim();
    const statusAfter = git(['status', '--porcelain=v1'], repo).stdout;

    expect(headAfter).toBe(headBefore);
    expect(statusAfter).toBe(statusBefore);
  });

  test('only read-only git subcommands are invoked (no add/commit/reset/stash)', () => {
    const repo = makeRepo('vibecode-gcf-readonly-');
    write(repo, 'a.txt', 'hi\n');

    const invoked: string[][] = [];
    const recordingRunner: GitReadOnlyRunner = (args, cwd): GitReadOnlyRunResult => {
      invoked.push(args);
      return defaultGitReadOnlyRunner(args, cwd);
    };

    getGitChangedFiles(repo, recordingRunner);

    expect(invoked.length).toBeGreaterThan(0);
    const mutating = ['add', 'commit', 'reset', 'stash', 'checkout', 'rm', 'clean', 'mv', 'restore', 'apply'];
    for (const args of invoked) {
      expect(mutating).not.toContain(args[0]);
    }
  });
});

describe('parsePorcelainZ', () => {
  test('unstaged modification', () => {
    const [f] = parsePorcelainZ(' M file.txt\0');
    expect(f.path).toBe('file.txt');
    expect(f.status).toBe('modified');
    expect(f.staged).toBe(false);
    expect(f.unstaged).toBe(true);
    expect(f.index_status).toBe(' ');
    expect(f.worktree_status).toBe('M');
  });

  test('staged addition', () => {
    const [f] = parsePorcelainZ('A  added.txt\0');
    expect(f.status).toBe('added');
    expect(f.staged).toBe(true);
    expect(f.unstaged).toBe(false);
  });

  test('deletion', () => {
    const [f] = parsePorcelainZ(' D gone.txt\0');
    expect(f.status).toBe('deleted');
  });

  test('rename consumes the following original-path token', () => {
    const [f] = parsePorcelainZ('R  new name.txt\0old name.txt\0');
    expect(f.status).toBe('renamed');
    expect(f.path).toBe('new name.txt');
    expect(f.original_path).toBe('old name.txt');
  });

  test('copy is classified as copied with original_path', () => {
    const [f] = parsePorcelainZ('C  copy.txt\0source.txt\0');
    expect(f.status).toBe('copied');
    expect(f.original_path).toBe('source.txt');
  });

  test('untracked', () => {
    const [f] = parsePorcelainZ('?? loose.txt\0');
    expect(f.status).toBe('untracked');
    expect(f.untracked).toBe(true);
  });

  test('type change', () => {
    const [f] = parsePorcelainZ(' T link\0');
    expect(f.status).toBe('type_changed');
  });

  test('staged and unstaged on the same file', () => {
    const [f] = parsePorcelainZ('MM both.txt\0');
    expect(f.staged).toBe(true);
    expect(f.unstaged).toBe(true);
    expect(f.status).toBe('modified');
  });

  test('backslashes are normalized to forward slashes', () => {
    const [f] = parsePorcelainZ('?? nested\\dir\\file.txt\0');
    expect(f.path).toBe('nested/dir/file.txt');
  });

  test('multiple entries including a rename are all parsed', () => {
    const z = 'RM b file.txt\0a file.txt\0?? new.txt\0';
    const files = parsePorcelainZ(z);
    expect(files.map((f) => f.path)).toEqual(['b file.txt', 'new.txt']);
    expect(files[0].status).toBe('renamed');
    expect(files[0].original_path).toBe('a file.txt');
    expect(files[0].staged).toBe(true);
    expect(files[0].unstaged).toBe(true);
  });

  test('empty output yields no files', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('isGeneratedOrIgnoredRuntimePath', () => {
  test('classifies known generated/ignored runtime roots', () => {
    expect(isGeneratedOrIgnoredRuntimePath('.vibecode/changed.json')).toBe(true);
    expect(isGeneratedOrIgnoredRuntimePath('.vibecode')).toBe(true);
    expect(isGeneratedOrIgnoredRuntimePath('.git/config')).toBe(true);
    expect(isGeneratedOrIgnoredRuntimePath('node_modules/foo/index.js')).toBe(true);
    expect(isGeneratedOrIgnoredRuntimePath('.codegraph/db')).toBe(true);
  });

  test('does not classify ordinary source paths', () => {
    expect(isGeneratedOrIgnoredRuntimePath('src/index.ts')).toBe(false);
    expect(isGeneratedOrIgnoredRuntimePath('README.md')).toBe(false);
    // only repo-root runtime roots count, not a same-named nested directory
    expect(isGeneratedOrIgnoredRuntimePath('src/.vibecode/x')).toBe(false);
  });

  test('tolerates backslash and leading ./ forms', () => {
    expect(isGeneratedOrIgnoredRuntimePath('.vibecode\\runs\\x.json')).toBe(true);
    expect(isGeneratedOrIgnoredRuntimePath('./.vibecode/x.json')).toBe(true);
  });
});
