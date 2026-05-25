import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { performScanPhase } from '../../../src/core/runs/scan_phase.js';
import { invokeScan } from '../../../src/core/scanning/scanner_subprocess.js';
import { buildScannerConfig } from '../../../src/core/scanning/scanner_config.js';

const mockedSpawnSync = vi.mocked(spawnSync);

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-scan-diag-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# scan diag fixture\n', 'utf8');
  return repoRoot;
}

describe('scanner diagnostics', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    mockedSpawnSync.mockReset();
  });

  test('invokeScan includes signal, cwd, repoRoot, stderr tail, and spawn error when scanner is terminated', async () => {
    mockedSpawnSync.mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: [
        'stderr line 01',
        'stderr line 02',
        'stderr line 03',
        'stderr line 04',
        'stderr line 05',
        'stderr line 06',
        'stderr line 07',
        'stderr line 08',
        'stderr line 09',
        'stderr line 10',
        'stderr line 11',
        'stderr line 12',
      ].join('\n'),
      error: new Error('spawn ENOENT'),
      pid: 1234,
      output: ['', '', ''],
    } as unknown as ReturnType<typeof spawnSync>);

    try {
      await invokeScan({
        scannerDir: '/project/dist-desktop/core/runs',
        config: buildScannerConfig({
          run_id: '20240101-010203-ABCD',
          task: 'diagnostic task',
          repo_root: '/project',
          out_dir: 'scan',
        }),
        repoRoot: '/project',
      });
      throw new Error('expected invokeScan to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('SCANNER_FAILED');
      expect(message).toContain('signal=SIGTERM');
      expect(message).toContain('exitCode=null');
      expect(message).toContain('cwd=/project/dist-desktop/core/runs');
      expect(message).toContain('repoRoot=/project');
      expect(message).toContain('spawnError=spawn ENOENT');
      expect(message).toContain('stderr:');
      expect(message).toContain('stderr line 12');
      expect(message).not.toContain('stderr line 01');
    }
  });

  test('invokeScan includes exitCode and stderr tail for non-zero exits', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 3,
      signal: null,
      stdout: 'stdout line 1\nstdout line 2\nstdout line 3\n',
      stderr: 'first\nsecond\nthird\n',
      pid: 1234,
      output: ['', '', ''],
    } as unknown as ReturnType<typeof spawnSync>);

    try {
      await invokeScan({
        scannerDir: '/project/src/core/scanning/python',
        config: buildScannerConfig({
          run_id: '20240101-010203-ABCD',
          task: 'diagnostic task',
          repo_root: '/project',
          out_dir: 'scan',
        }),
        repoRoot: '/project',
      });
      throw new Error('expected invokeScan to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('SCANNER_FAILED');
      expect(message).toContain('exitCode=3');
      expect(message).toContain('signal=none');
      expect(message).toContain('stderr:');
      expect(message).toContain('third');
      expect(message).toContain('stdout:');
      expect(message).toContain('stdout line 3');
      expect(message).toContain('cwd=/project/src/core/scanning/python');
    }
  });

  test('performScanPhase includes cwd and repoRoot in the diagnostic when scanner exits with code null', async () => {
    const repoRoot = makeRepo();
    mockedSpawnSync.mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: 'failed to spawn\nmore detail\n',
      error: new Error('spawn ENOENT'),
      pid: 4321,
      output: ['', '', ''],
    } as unknown as ReturnType<typeof spawnSync>);

    try {
      const result = await performScanPhase({ task: 'diagnostic task', repoRoot });
      expect(result.status).toBe('error');
      if (result.status === 'ok') return;
      expect(result.diagnostic).toContain('SCANNER_FAILED');
      expect(result.diagnostic).toContain('exitCode=null');
      expect(result.diagnostic).toContain('signal=SIGTERM');
      expect(result.diagnostic).toContain(`repoRoot=${repoRoot}`);
      expect(result.diagnostic).toContain('cwd=');
      expect(result.diagnostic).toContain(path.join('src', 'core', 'scanning', 'python'));
      expect(result.diagnostic).toContain('spawnError=spawn ENOENT');
      expect(result.diagnostic).toContain('failed to spawn');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('performScanPhase returns a structured diagnostic instead of throwing when run_manifest.json is unreadable', async () => {
    const repoRoot = makeRepo();
    mockedSpawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      pid: 4321,
      output: ['', '', ''],
    } as unknown as ReturnType<typeof spawnSync>);

    const originalReadFileSync = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof filePath === 'string' && filePath.endsWith(`${path.sep}run_manifest.json`)) {
        return '{ invalid json';
      }
      return originalReadFileSync(filePath, options as Parameters<typeof fs.readFileSync>[1]);
    }) as typeof fs.readFileSync);

    try {
      const result = await performScanPhase({ task: 'manifest diagnostic task', repoRoot });
      expect(result.status).toBe('error');
      if (result.status === 'ok') return;
      expect(result.diagnostic).toContain('RUN_MANIFEST_INVALID');
      expect(result.diagnostic).toContain('run_manifest.json');
      expect(result.diagnostic).toContain(`repoRoot=${repoRoot}`);
      expect(result.diagnostic).toContain('failed to read run manifest');
    } finally {
      readSpy.mockRestore();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
