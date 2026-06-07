import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { buildArgs, buildSpawnEnv, formatScannerFailureDiagnostic, invokeScan, resolvePythonCommand, ScannerSubprocess } from '../../src/core/scanning/scanner_subprocess';
import { buildScannerConfig } from '../../src/core/scanning/scanner_config';

const mockedSpawnSync = vi.mocked(spawnSync);

describe('ScannerSubprocess adapter', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    mockedSpawnSync.mockReset();
  });

  test('ScannerSubprocess has invokeScan method', () => {
    const scanner = new ScannerSubprocess({
      scannerDir: '/tmp/scanner',
      config: buildScannerConfig({
        run_id: '20240101-010203-ABCD',
        task: 'test',
        repo_root: '/repo',
        out_dir: 'scan',
      }),
      repoRoot: '/repo',
    });

    expect(typeof scanner.invokeScan).toBe('function');
  });

  test('ScannerSubprocess buildArgs returns correct args array', () => {
    const args = buildArgs({
      scannerDir: path.join('/repo', 'src', 'core', 'scanning', 'python'),
      config: buildScannerConfig({
        run_id: '20240101-010203-ABCD',
        task: 'test',
        repo_root: '/repo',
        out_dir: 'scan',
      }),
      repoRoot: '/repo',
      pythonPath: 'python',
    });

    expect(args).toContain('-m');
    expect(args).toContain('vibecode_scanner');
    expect(args).toContain('--repo');
    expect(args).toContain('/repo');
    expect(args).toContain('--task');
    expect(args).toContain('test');
  });

  test('buildArgs uses explicit pythonPath when provided', () => {
    const args = buildArgs({
      scannerDir: '/tmp/scanner',
      config: buildScannerConfig({
        run_id: 'run1',
        task: 'test',
        repo_root: '/repo',
        out_dir: 'scan',
      }),
      repoRoot: '/repo',
      pythonPath: '/usr/local/bin/python3.12',
    });

    expect(args[0]).toBe('/usr/local/bin/python3.12');
  });

  test('resolvePythonCommand returns [explicitPath] when pythonPath is provided', () => {
    const result = resolvePythonCommand({ pythonPath: '/custom/python3' }, {});
    expect(result).toEqual(['/custom/python3']);
  });

  test('resolvePythonCommand returns [VIBECODE_PYTHON] when env is set', () => {
    const result = resolvePythonCommand({}, { VIBECODE_PYTHON: '/opt/python3' });
    expect(result).toEqual(['/opt/python3']);
  });

  test('resolvePythonCommand returns [python3, python] as default fallback', () => {
    const result = resolvePythonCommand({}, {});
    expect(result).toEqual(['python3', 'python']);
  });

  test('resolvePythonCommand explicit pythonPath wins over VIBECODE_PYTHON env', () => {
    const result = resolvePythonCommand(
      { pythonPath: '/explicit/python3' },
      { VIBECODE_PYTHON: '/opt/python3' },
    );
    expect(result).toEqual(['/explicit/python3']);
  });

  test('formatScannerFailureDiagnostic lists only attempted commands', () => {
    const diag = formatScannerFailureDiagnostic({
      cwd: '/scanner',
      repoRoot: '/repo',
      result: { status: 1, stderr: 'err', stdout: '' },
      attemptedCommands: ['python3', 'python'],
    });
    expect(diag).toContain('attempted: python3, python');
  });

  test('formatScannerFailureDiagnostic omits attempted when not provided', () => {
    const diag = formatScannerFailureDiagnostic({
      cwd: '/scanner',
      repoRoot: '/repo',
      result: { status: 1, stderr: '', stdout: '' },
    });
    expect(diag).not.toContain('attempted');
  });
});

describe('buildSpawnEnv', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv, TEST_BASE_VAR: 'base_value' };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  test('returns undefined when optsEnv is not provided', () => {
    expect(buildSpawnEnv(undefined)).toBeUndefined();
  });

  test('merges optsEnv with process.env when optsEnv is provided', () => {
    const result = buildSpawnEnv({ CUSTOM_VAR: 'custom' });
    expect(result).toBeDefined();
    expect(result!.CUSTOM_VAR).toBe('custom');
    expect(result!.TEST_BASE_VAR).toBe('base_value');
  });

  test('optsEnv overrides process.env for same key', () => {
    const result = buildSpawnEnv({ TEST_BASE_VAR: 'overridden' });
    expect(result!.TEST_BASE_VAR).toBe('overridden');
  });

  test('filters undefined values from optsEnv', () => {
    const result = buildSpawnEnv({ UNDEFINED_VAR: undefined, DEFINED_VAR: 'yes' });
    expect(result).toBeDefined();
    expect(result!['UNDEFINED_VAR']).toBeUndefined();
    expect(result!.DEFINED_VAR).toBe('yes');
    expect(Object.prototype.hasOwnProperty.call(result, 'UNDEFINED_VAR')).toBe(false);
  });

  test('filters undefined values from process.env entries', () => {
    process.env.UNDEF_BASE = undefined;
    const result = buildSpawnEnv({ EXTRA: 'val' });
    expect(Object.prototype.hasOwnProperty.call(result, 'UNDEF_BASE')).toBe(false);
    expect(result!.EXTRA).toBe('val');
  });
});

describe('invokeScan fallback', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    mockedSpawnSync.mockReset();
  });

  test('falls back from python3 to python when python3 fails and returns success', async () => {
    let callIndex = 0;
    mockedSpawnSync.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return {
          status: 1,
          signal: null,
          stdout: '',
          stderr: 'python3 not found',
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

    await expect(invokeScan({
      scannerDir: '/scanner',
      config: buildScannerConfig({
        run_id: 'run-fallback',
        task: 'test',
        repo_root: '/repo',
        out_dir: 'scan',
      }),
      repoRoot: '/repo',
    })).resolves.toBeUndefined();

    expect(mockedSpawnSync).toHaveBeenCalledTimes(2);
    expect(mockedSpawnSync.mock.calls[0][0]).toBe('python3');
    expect(mockedSpawnSync.mock.calls[1][0]).toBe('python');
  });

  test('records attemptedCommands with both python3 and python in diagnostic when both fail', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'scanner error',
      pid: 100,
      output: ['', '', ''],
    } as unknown as ReturnType<typeof spawnSync>);

    await expect(invokeScan({
      scannerDir: '/scanner',
      config: buildScannerConfig({
        run_id: 'run-both-fail',
        task: 'test',
        repo_root: '/repo',
        out_dir: 'scan',
      }),
      repoRoot: '/repo',
    })).rejects.toThrow(/attempted: python3, python/);
  });

  test('does not attempt python when explicit pythonPath is provided', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'failed',
      pid: 100,
      output: ['', '', ''],
    } as unknown as ReturnType<typeof spawnSync>);

    await expect(invokeScan({
      scannerDir: '/scanner',
      config: buildScannerConfig({
        run_id: 'run-explicit',
        task: 'test',
        repo_root: '/repo',
        out_dir: 'scan',
      }),
      repoRoot: '/repo',
      pythonPath: '/custom/python',
    })).rejects.toThrow(/attempted: \/custom\/python/);

    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockedSpawnSync.mock.calls[0][0]).toBe('/custom/python');
  });

  test('passes merged env to spawnSync via buildSpawnEnv', async () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
      pid: 100,
      output: ['', '', ''],
    } as unknown as ReturnType<typeof spawnSync>);

    await invokeScan({
      scannerDir: '/scanner',
      config: buildScannerConfig({
        run_id: 'run-env',
        task: 'test',
        repo_root: '/repo',
        out_dir: 'scan',
      }),
      repoRoot: '/repo',
      env: { VIBECODE_PYTHON: 'python', CUSTOM_SCANNER_VAR: 'test123' },
    });

    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    const spawnEnv = mockedSpawnSync.mock.calls[0][2]?.env as Record<string, string>;
    expect(spawnEnv.CUSTOM_SCANNER_VAR).toBe('test123');
    expect(spawnEnv.PATH).toBeDefined();
  });
});
