import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { performScanPhase } from '../../../src/core/runs/scan_phase.js';

const mockedSpawnSync = vi.mocked(spawnSync);

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ext-tools-phase-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  return repoRoot;
}

function mockScannerSuccess(): void {
  mockedSpawnSync.mockReturnValue({
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    pid: 1,
    output: ['', '', ''],
  } as unknown as ReturnType<typeof spawnSync>);
}

describe('performScanPhase external_tools.json artifact', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    mockedSpawnSync.mockReset();
  });

  test('produces scan/external_tools.json with a stable detect-only shape', async () => {
    const repoRoot = makeRepo();
    mockScannerSuccess();
    try {
      const result = await performScanPhase({ task: 'detect external tools', repoRoot });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      const externalToolsPath = path.join(result.scanDir, 'external_tools.json');
      expect(fs.existsSync(externalToolsPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(externalToolsPath, 'utf8'));
      expect(parsed.tools.codegraph.mode).toBe('detect-only');
      expect(typeof parsed.tools.codegraph.available).toBe('boolean');
      expect(typeof parsed.tools.codegraph.initialized).toBe('boolean');
      expect(Array.isArray(parsed.tools.codegraph.warnings)).toBe(true);

      // The artifact is surfaced in the returned artifact list.
      expect(Object.values(result.artifacts)).toContain(externalToolsPath);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not contain graph dumps or source snippets', async () => {
    const repoRoot = makeRepo();
    mockScannerSuccess();
    try {
      const result = await performScanPhase({ task: 'detect external tools', repoRoot });
      if (result.status !== 'ok') throw new Error('scan failed');
      const serialized = fs.readFileSync(path.join(result.scanDir, 'external_tools.json'), 'utf8');
      expect(serialized).not.toContain('snippet');
      expect(serialized).not.toContain('nodes');
      expect(serialized).not.toContain('edges');
      expect(serialized).not.toContain('context_pack');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('records initialized=true and codegraph_dir when .codegraph/ exists', async () => {
    const repoRoot = makeRepo();
    fs.mkdirSync(path.join(repoRoot, '.codegraph'));
    fs.writeFileSync(path.join(repoRoot, '.codegraph', 'codegraph.db'), 'binary');
    mockScannerSuccess();
    try {
      const result = await performScanPhase({ task: 'detect external tools', repoRoot });
      if (result.status !== 'ok') throw new Error('scan failed');
      const parsed = JSON.parse(
        fs.readFileSync(path.join(result.scanDir, 'external_tools.json'), 'utf8'),
      );
      expect(parsed.tools.codegraph.initialized).toBe(true);
      expect(parsed.tools.codegraph.codegraph_dir).toBe('.codegraph');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('does not create .codegraph/ when it is absent (no init/index/sync/watch)', async () => {
    const repoRoot = makeRepo();
    mockScannerSuccess();
    try {
      const result = await performScanPhase({ task: 'detect external tools', repoRoot });
      if (result.status !== 'ok') throw new Error('scan failed');
      expect(fs.existsSync(path.join(repoRoot, '.codegraph'))).toBe(false);
      const parsed = JSON.parse(
        fs.readFileSync(path.join(result.scanDir, 'external_tools.json'), 'utf8'),
      );
      expect(parsed.tools.codegraph.initialized).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
