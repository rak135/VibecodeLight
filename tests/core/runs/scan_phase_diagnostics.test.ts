import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('../../../src/adapters/codegraph/codegraph_cli.js', () => ({
  detectCodeGraph: vi.fn().mockResolvedValue({ available: false, initialized: false, warnings: [] }),
}));

vi.mock('../../../src/core/scanning/external_tools.js', () => ({
  writeExternalToolsArtifact: vi.fn().mockReturnValue('/mock/external_tools.json'),
}));

import { performScanPhase } from '../../../src/core/runs/scan_phase.js';
import { invokeScan } from '../../../src/core/scanning/scanner_subprocess.js';
import { buildScannerConfig, buildScannerConfigPayload } from '../../../src/core/scanning/scanner_config.js';

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

describe('scanner config typing', () => {
  test('scanner_config.json includes typed enrichment fields when taskIntent is provided', async () => {
    const repoRoot = makeRepo();
    let callIndex = 0;
    mockedSpawnSync.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return {
          status: 9009,
          signal: null,
          stdout: '',
          stderr: '',
          pid: 100,
          output: ['', '', ''],
        } as unknown as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        pid: 101,
        output: ['', '', ''],
      } as unknown as ReturnType<typeof spawnSync>;
    });

    try {
      const result = await performScanPhase({
        task: 'test enrichment task',
        repoRoot,
        taskIntent: {
          enabled: true,
          ok: true,
          source: 'llm',
          original_task: 'test enrichment task',
          original_language: 'en',
          normalized_english_task: 'add dark mode toggle',
          search_hints: ['dark mode', 'theme toggle'],
          keyword_groups: {
            core_terms: ['dark', 'mode'],
            ui_terms: ['toggle'],
            persistence_terms: [],
            cli_terms: [],
            test_terms: [],
          },
          negative_constraints: [],
          validation_hints: [],
          uncertainties: [],
          warnings: [],
          model: { provider: 'test', model: 'test', live: false },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      const configPath = path.join(result.runDir, 'scanner_config.json');
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.run_id).toBe(result.run_id);
      expect(written.task).toBe('test enrichment task');
      expect(written.repo_root).toBe(repoRoot);
      expect(written.out_dir).toBe('scan');
      expect(written.normalized_english_task).toBe('add dark mode toggle');
      expect(written.search_hints).toEqual(['dark mode', 'theme toggle']);
      expect(written.keyword_groups).toEqual(expect.objectContaining({ core_terms: ['dark', 'mode'] }));
      expect(written._provenance_note).toContain('Task Normalizer');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('scanner_config.json has empty enrichment fields when no taskIntent is provided', async () => {
    const repoRoot = makeRepo();
    let callIndex = 0;
    mockedSpawnSync.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return {
          status: 9009,
          signal: null,
          stdout: '',
          stderr: '',
          pid: 100,
          output: ['', '', ''],
        } as unknown as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        pid: 101,
        output: ['', '', ''],
      } as unknown as ReturnType<typeof spawnSync>;
    });

    try {
      const result = await performScanPhase({ task: 'bare task', repoRoot });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      const configPath = path.join(result.runDir, 'scanner_config.json');
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.run_id).toBe(result.run_id);
      expect(written.task).toBe('bare task');
      expect(written.repo_root).toBe(repoRoot);
      expect(written.out_dir).toBe('scan');
      expect(written.normalized_english_task).toBe('');
      expect(written.search_hints).toEqual([]);
      expect(written.keyword_groups).toEqual({});
      expect(written._provenance_note).toContain('Task Normalizer');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('buildScannerConfigPayload', () => {
  test('buildScannerConfigPayload returns typed payload with enrichment when taskIntent is ok', () => {
    const base = buildScannerConfig({ run_id: 'r1', task: 't', repo_root: '/repo', out_dir: 'scan' });
    const payload = buildScannerConfigPayload(base, {
      enabled: true,
      ok: true,
      source: 'llm',
      original_task: 't',
      original_language: 'en',
      normalized_english_task: 'normalized',
      search_hints: ['hint1'],
      keyword_groups: { core_terms: ['a'], ui_terms: [], persistence_terms: [], cli_terms: [], test_terms: [] },
      negative_constraints: [],
      validation_hints: [],
      uncertainties: [],
      warnings: [],
      model: { provider: 'p', model: 'm', live: false },
    });
    expect(payload.run_id).toBe('r1');
    expect(payload.normalized_english_task).toBe('normalized');
    expect(payload.search_hints).toEqual(['hint1']);
    expect(payload.keyword_groups.core_terms).toEqual(['a']);
    expect(payload._provenance_note).toContain('Task Normalizer');
  });

  test('buildScannerConfigPayload returns empty enrichment when taskIntent is disabled', () => {
    const base = buildScannerConfig({ run_id: 'r1', task: 't', repo_root: '/repo', out_dir: 'scan' });
    const payload = buildScannerConfigPayload(base, {
      enabled: false,
      ok: true,
      source: 'disabled',
      original_task: 't',
      original_language: 'unknown',
      normalized_english_task: '',
      search_hints: [],
      keyword_groups: {},
      negative_constraints: [],
      validation_hints: [],
      uncertainties: [],
      warnings: [],
    });
    expect(payload.normalized_english_task).toBe('');
    expect(payload.search_hints).toEqual([]);
    expect(payload.keyword_groups).toEqual({});
  });

  test('buildScannerConfigPayload returns empty enrichment when taskIntent is undefined', () => {
    const base = buildScannerConfig({ run_id: 'r1', task: 't', repo_root: '/repo', out_dir: 'scan' });
    const payload = buildScannerConfigPayload(base);
    expect(payload.normalized_english_task).toBe('');
    expect(payload.search_hints).toEqual([]);
    expect(payload.keyword_groups).toEqual({});
  });
});

describe('performScanPhase production-path regression guard', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    mockedSpawnSync.mockReset();
  });

  test('performScanPhase uses invokeScan multi-candidate fallback when python3 is unavailable', async () => {
    const repoRoot = makeRepo();
    let callIndex = 0;
    mockedSpawnSync.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return {
          status: 9009,
          signal: null,
          stdout: '',
          stderr: '',
          pid: 100,
          output: ['', '', ''],
        } as unknown as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        pid: 101,
        output: ['', '', ''],
      } as unknown as ReturnType<typeof spawnSync>;
    });

    try {
      const result = await performScanPhase({ task: 'fallback regression', repoRoot });
      expect(result.status).toBe('ok');
      expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
      expect(mockedSpawnSync.mock.calls[0][0]).toContain('python3');
      expect(mockedSpawnSync.mock.calls[1][0]).toContain('python');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
