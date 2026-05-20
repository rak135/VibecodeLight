import { spawnSync } from 'child_process';

import { ScannerConfig } from '../models/index.js';
import { getScannerConfigPaths } from './scanner_config.js';

export interface ScanInvokeOptions {
  pythonPath?: string;
  scannerDir: string;
  config: ScannerConfig;
  repoRoot: string;
}

export interface ScannerSpawnResult {
  status: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: Error | null;
}

function tailLines(value: string | undefined, maxLines: number): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  return trimmed.split(/\r?\n/).slice(-maxLines).join('\n');
}

export function formatScannerFailureDiagnostic(opts: {
  cwd: string;
  repoRoot: string;
  result: ScannerSpawnResult;
}): string {
  const stderrTail = tailLines(opts.result.stderr, 10);
  const stdoutTail = tailLines(opts.result.stdout, 5);
  const spawnError = opts.result.error ? ` spawnError=${opts.result.error.message}` : '';

  return (
    `SCANNER_FAILED: exitCode=${opts.result.status} signal=${opts.result.signal ?? 'none'}` +
    spawnError +
    `\ncwd=${opts.cwd}` +
    `\nrepoRoot=${opts.repoRoot}` +
    (stderrTail ? `\nstderr:\n${stderrTail}` : '') +
    (stdoutTail ? `\nstdout:\n${stdoutTail}` : '')
  );
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
    throw new Error(formatScannerFailureDiagnostic({ cwd: opts.scannerDir, repoRoot: opts.repoRoot, result }));
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
