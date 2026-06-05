import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DEFAULT_REPO_ROOT_ENV_VAR,
  resolveRepoRoot,
} from '../../../src/core/workspace/repo_root.js';

describe('resolveRepoRoot', () => {
  let tmpDir: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-core-repo-root-'));
    envBackup = process.env[DEFAULT_REPO_ROOT_ENV_VAR];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (envBackup === undefined) {
      delete process.env[DEFAULT_REPO_ROOT_ENV_VAR];
    } else {
      process.env[DEFAULT_REPO_ROOT_ENV_VAR] = envBackup;
    }
  });

  test('explicit repoArg wins over env and cwd', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-other-'));
    try {
      const result = resolveRepoRoot({
        repoArg: tmpDir,
        env: { [DEFAULT_REPO_ROOT_ENV_VAR]: otherDir },
        cwd: '/some/other/dir',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.repoRoot).toBe(path.resolve(tmpDir));
      expect(result.source).toBe('arg');
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('falls back to env var when no repoArg', () => {
    const result = resolveRepoRoot({
      env: { [DEFAULT_REPO_ROOT_ENV_VAR]: tmpDir },
      cwd: '/some/other/dir',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
    expect(result.source).toBe('env');
  });

  test('falls back to cwd when neither repoArg nor env is set', () => {
    const result = resolveRepoRoot({
      env: {},
      cwd: tmpDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
    expect(result.source).toBe('cwd');
  });

  test('whitespace-only repoArg is ignored', () => {
    const result = resolveRepoRoot({
      repoArg: '   ',
      env: { [DEFAULT_REPO_ROOT_ENV_VAR]: tmpDir },
      cwd: '/nope',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('env');
  });

  test('whitespace-only env value is ignored', () => {
    const result = resolveRepoRoot({
      env: { [DEFAULT_REPO_ROOT_ENV_VAR]: '   ' },
      cwd: tmpDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('cwd');
  });

  test('REPO_NOT_FOUND on a path that does not exist', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = resolveRepoRoot({ repoArg: missing, cwd: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REPO_NOT_FOUND');
    expect(result.error.message).toMatch(/does not exist/i);
    expect(result.error.message).not.toMatch(/ENOENT/);
    expect(typeof result.error.resolvedPath).toBe('string');
    expect(Array.isArray(result.error.details)).toBe(true);
  });

  test('REPO_NOT_A_DIRECTORY when path resolves to a file', () => {
    const filePath = path.join(tmpDir, 'somefile.txt');
    fs.writeFileSync(filePath, 'hello', 'utf8');
    const result = resolveRepoRoot({ repoArg: filePath, cwd: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REPO_NOT_A_DIRECTORY');
    expect(result.error.message).toMatch(/not a directory/i);
  });

  test('reads from process.env by default', () => {
    process.env[DEFAULT_REPO_ROOT_ENV_VAR] = tmpDir;
    const result = resolveRepoRoot({ cwd: '/nope' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
    expect(result.source).toBe('env');
  });

  test('honors a custom envVarName', () => {
    const result = resolveRepoRoot({
      env: { MY_CUSTOM_REPO: tmpDir },
      envVarName: 'MY_CUSTOM_REPO',
      cwd: '/nope',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe('env');
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
  });

  test('error message mentions the env var name in details', () => {
    const result = resolveRepoRoot({
      env: { MY_REPO: path.join(tmpDir, 'nope') },
      envVarName: 'MY_REPO',
      cwd: '/nope',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details.join('\n')).toMatch(/MY_REPO env/);
  });
});

describe('legacy desktop wrapper preserves behavior', () => {
  let tmpDir: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-desktop-repo-resolver-'));
    envBackup = process.env.VIBECODE_REPO;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (envBackup === undefined) delete process.env.VIBECODE_REPO;
    else process.env.VIBECODE_REPO = envBackup;
  });

  test('resolveDesktopRepo still resolves a directory through the new core', async () => {
    const { resolveDesktopRepo } = await import('../../../src/app/desktop/repo_resolver.js');
    process.env.VIBECODE_REPO = tmpDir;
    const result = resolveDesktopRepo({ cwd: '/nope' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
    expect(result.source).toBe('env');
  });
});
