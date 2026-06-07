import path from 'path';

import { buildArgs, resolvePythonCommand, ScannerSubprocess } from '../../src/core/scanning/scanner_subprocess';
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

  test('resolvePythonCommand prefers explicit pythonPath option', () => {
    const result = resolvePythonCommand({ pythonPath: '/custom/python3' }, {});
    expect(result).toBe('/custom/python3');
  });

  test('resolvePythonCommand prefers VIBECODE_PYTHON env over default', () => {
    const result = resolvePythonCommand({}, { VIBECODE_PYTHON: '/opt/python3' });
    expect(result).toBe('/opt/python3');
  });

  test('resolvePythonCommand falls back to python3 then python', () => {
    const result = resolvePythonCommand({}, {});
    expect(result).toBe('python3');
  });
});
