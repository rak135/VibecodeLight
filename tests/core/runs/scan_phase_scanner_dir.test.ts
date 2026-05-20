import path from 'path';

import { resolveScannerDir } from '../../../src/core/runs/scan_phase.js';

describe('scan phase scanner directory resolution', () => {
  test('resolveScannerDir works from dist-desktop compiled path', () => {
    const repoRoot = path.resolve(process.cwd());
    const fromDir = path.join(repoRoot, 'dist-desktop', 'core', 'runs');
    const expected = path.join(repoRoot, 'src', 'core', 'scanning', 'python');

    expect(resolveScannerDir(fromDir)).toBe(expected);
    expect(resolveScannerDir(fromDir)).not.toContain('dist-desktop');
  });

  test('resolveScannerDir works from src dev path', () => {
    const repoRoot = path.resolve(process.cwd());
    const fromDir = path.join(repoRoot, 'src', 'core', 'runs');
    const expected = path.join(repoRoot, 'src', 'core', 'scanning', 'python');

    expect(resolveScannerDir(fromDir)).toBe(expected);
  });

  test('SCANNER_DIR resolution does not use a dist-desktop relative path', () => {
    const repoRoot = path.resolve(process.cwd());
    const expected = path.join(repoRoot, 'src', 'core', 'scanning', 'python');

    expect(resolveScannerDir(path.join(repoRoot, 'dist-desktop', 'core', 'runs'))).toBe(expected);
    expect(resolveScannerDir(path.join(repoRoot, 'src', 'core', 'runs'))).toBe(expected);
  });
});
