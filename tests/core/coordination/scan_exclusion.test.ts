import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { getCoordinationPaths } from '../../../src/core/coordination/state.js';

/**
 * Coordination state is generated working state under .vibecode/. It must be
 * (a) git-ignored and (b) excluded by the Python repository scanner, exactly
 * like the rest of .vibecode/. The Python scanner must NOT own coordination
 * state — it only has to keep excluding it as source content.
 */

const repoRoot = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('coordination state is generated, not source', () => {
  test('state file path is under the git-ignored .vibecode/ tree', () => {
    const paths = getCoordinationPaths('/repo/root');
    expect(paths.stateFile).toContain(path.join('.vibecode', 'coordination'));
  });

  test('.gitignore excludes the .vibecode/ generated tree', () => {
    const gitignore = read('.gitignore');
    expect(gitignore).toMatch(/^\.vibecode\/?$/m);
  });

  test('Python scanner always excludes .vibecode/ (so coordination state is never scanned as source)', () => {
    // Characterization: the scanner keeps .vibecode in its hard exclusion list.
    // Coordination state lives under .vibecode/coordination/, so it inherits
    // this exclusion without the scanner knowing anything about coordination.
    const baseScan = read('src/core/scanning/python/vibecode_scanner/scan/base_scan.py');
    expect(baseScan).toMatch(/ALWAYS_EXCLUDED\s*=\s*\[[^\]]*["']\.vibecode["']/);
  });
});
