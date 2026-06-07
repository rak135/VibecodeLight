import { spawnSync } from 'child_process';

import { ScannerConfig } from '../models/index.js';
import { getScannerConfigPaths } from './scanner_config.js';

export interface ScanInvokeOptions {
  pythonPath?: string;
  scannerDir: string;
  config: ScannerConfig;
  repoRoot: string;
  env?: Record<string, string | undefined>;
}

export interface ScannerSpawnResult {
  status: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  error?: Error | null;
}

export function resolvePythonCommand(
  opts: Pick<ScanInvokeOptions, 'pythonPath'>,
  env: Record<string, string | undefined> = process.env,
): string {
  if (opts.pythonPath) {
    return opts.pythonPath;
  }
  const fromEnv = env.VIBECODE_PYTHON?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return 'python3';
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
  attemptedCommands?: string[];
}): string {
  const stderrTail = tailLines(opts.result.stderr, 10);
  const stdoutTail = tailLines(opts.result.stdout, 5);
  const spawnError = opts.result.error ? ` spawnError=${opts.result.error.message}` : '';
  const attempted = opts.attemptedCommands?.length
    ? `\nattempted: ${opts.attemptedCommands.join(', ')}`
    : '';

  return (
    `SCANNER_FAILED: exitCode=${opts.result.status} signal=${opts.result.signal ?? 'none'}` +
    spawnError +
    `\ncwd=${opts.cwd}` +
    `\nrepoRoot=${opts.repoRoot}` +
    attempted +
    (stderrTail ? `\nstderr:\n${stderrTail}` : '') +
    (stdoutTail ? `\nstdout:\n${stdoutTail}` : '')
  );
}

export function buildArgs(opts: ScanInvokeOptions): string[] {
  const pythonPath = resolvePythonCommand(opts, opts.env ?? process.env);
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
    throw new Error(
      formatScannerFailureDiagnostic({
        cwd: opts.scannerDir,
        repoRoot: opts.repoRoot,
        result,
        attemptedCommands: [cmd, 'python3', 'python'],
      }),
    );
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
