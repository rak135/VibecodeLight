import path from 'path';

import { ScannerConfig } from '../models/index.js';

export function buildScannerConfig(opts: {
  run_id: string;
  task: string;
  repo_root: string;
  out_dir: string;
}): ScannerConfig {
  return {
    run_id: opts.run_id,
    task: opts.task,
    repo_root: opts.repo_root,
    out_dir: opts.out_dir,
  };
}

export function getScannerConfigPaths(repoRoot: string, runId: string) {
  const runRoot = path.join(repoRoot, '.vibecode', 'runs', runId);
  return {
    runRoot,
    scannerConfigPath: path.join(runRoot, 'scanner_config.json'),
    scanOutDir: path.join(runRoot, 'scan'),
  };
}
