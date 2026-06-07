import path from 'path';

import { buildArgs, formatScannerFailureDiagnostic, resolvePythonCommand, ScannerSubprocess } from '../../src/core/scanning/scanner_subprocess';
import { buildScannerConfig } from '../../src/core/scanning/scanner_config';

describe('ScannerSubprocess adapter', () => {
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
