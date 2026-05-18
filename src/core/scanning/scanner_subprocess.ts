import { spawnSync } from 'child_process';

import { ScannerConfig } from '../models/index.js';
import { getScannerConfigPaths } from './scanner_config.js';

export interface ScanInvokeOptions {
  pythonPath?: string;
  scannerDir: string;
  config: ScannerConfig;
  repoRoot: string;
}

export function buildArgs(opts: ScanInvokeOptions): string[] {
  const pythonPath = opts.pythonPath ?? 'python';
  const paths = getScannerConfigPaths(opts.repoRoot, opts.config.run_id);
  return [
    pythonPath,
    '-m',
    'vibecode_scanner',
    '--repo',
    opts.repoRoot,
    '--task',
    opts.config.task,
    '--scanner-config',
    paths.scannerConfigPath,
    '--out',
    paths.scanOutDir,
  ];
}

export async function invokeScan(opts: ScanInvokeOptions): Promise<void> {
  const [cmd, ...args] = buildArgs(opts);
  const result = spawnSync(cmd, args, {
    cwd: opts.scannerDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `scanner exited with ${result.status}`);
  }
}

export class ScannerSubprocess {
  private readonly opts: ScanInvokeOptions;

  constructor(opts: ScanInvokeOptions) {
    this.opts = opts;
  }

  invokeScan(): Promise<void> {
    return invokeScan(this.opts);
  }

  static buildArgs(opts: ScanInvokeOptions): string[] {
    return buildArgs(opts);
  }
}
