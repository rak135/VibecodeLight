import fs from 'fs';
import os from 'os';
import path from 'path';

describe('resolveDesktopRepo', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-repo-resolver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.VIBECODE_REPO;
  });

  test('uses VIBECODE_REPO env when set', async () => {
    const { resolveDesktopRepo } = await import('../../../src/app/desktop/repo_resolver.js');
    process.env.VIBECODE_REPO = tmpDir;
    const result = resolveDesktopRepo({ cwd: '/some/other/dir' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
  });

  test('uses explicit repo arg over VIBECODE_REPO', async () => {
    const { resolveDesktopRepo } = await import('../../../src/app/desktop/repo_resolver.js');
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-other-'));
    process.env.VIBECODE_REPO = otherDir;
    const result = resolveDesktopRepo({ repoArg: tmpDir, cwd: '/some/other/dir' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  test('falls back to cwd when no env or arg', async () => {
    const { resolveDesktopRepo } = await import('../../../src/app/desktop/repo_resolver.js');
    delete process.env.VIBECODE_REPO;
    const result = resolveDesktopRepo({ cwd: tmpDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repoRoot).toBe(path.resolve(tmpDir));
  });

  test('rejects non-existent path with structured diagnostic', async () => {
    const { resolveDesktopRepo } = await import('../../../src/app/desktop/repo_resolver.js');
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = resolveDesktopRepo({ repoArg: missing, cwd: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REPO_NOT_FOUND');
    expect(result.error.message).toMatch(/does not exist/i);
    expect(typeof result.error.resolvedPath).toBe('string');
  });

  test('rejects file path (not a directory) with structured diagnostic', async () => {
    const { resolveDesktopRepo } = await import('../../../src/app/desktop/repo_resolver.js');
    const filePath = path.join(tmpDir, 'somefile.txt');
    fs.writeFileSync(filePath, 'hello');
    const result = resolveDesktopRepo({ repoArg: filePath, cwd: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('REPO_NOT_A_DIRECTORY');
    expect(result.error.message).toMatch(/not a directory/i);
  });
});
