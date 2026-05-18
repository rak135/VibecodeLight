import path from 'path';

import { buildArgs, ScannerSubprocess } from '../../src/core/scanning/scanner_subprocess';
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
});
