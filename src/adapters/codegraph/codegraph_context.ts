import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { CODEGRAPH_COMMAND } from './codegraph_cli.js';
import { getCodeGraphStatus, type CodeGraphStatusResult, type CodeGraphRunResult } from './codegraph_actions.js';

export type CodeGraphContextMode = 'detect-only' | 'use-existing';

export interface CodeGraphContextResult {
  ok: boolean;
  used: boolean;
  mode: CodeGraphContextMode;
  command?: string[];
  artifact?: string;
  outputText?: string;
  warnings: string[];
  reason?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type CodeGraphContextRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
) => CodeGraphRunResult;

export type CodeGraphReadinessProvider = (repoRoot: string) => Promise<CodeGraphStatusResult>;

export interface BuildCodeGraphContextInput {
  repoRoot: string;
  task: string;
  mode?: CodeGraphContextMode;
  maxBytes?: number;
  timeoutMs?: number;
  command?: string;
  runner?: CodeGraphContextRunner;
  readinessProvider?: CodeGraphReadinessProvider;
}

export interface CodeGraphArtifactWriteResult {
  usageArtifact: string;
  contextArtifact?: string;
}

const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const CONTEXT_RELATIVE_ARTIFACT = 'scan/codegraph_context.md';
const USAGE_RELATIVE_ARTIFACT = 'scan/codegraph_usage.json';

export function parseWindowsNpmShimTarget(contents: string, shimDir: string): string | undefined {
  const match = contents.match(/"%dp0%\\([^"]+?\.js)"/i);
  if (!match) return undefined;
  return path.join(shimDir, ...match[1].split(/[\\/]+/));
}

function findOnPath(fileName: string): string | undefined {
  if (path.isAbsolute(fileName) && fs.existsSync(fileName)) return fileName;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveWindowsNpmShimScript(command: string): string | undefined {
  const shimPath = findOnPath(command);
  if (!shimPath) return undefined;
  try {
    const contents = fs.readFileSync(shimPath, 'utf8');
    return parseWindowsNpmShimTarget(contents, path.dirname(shimPath));
  } catch {
    return undefined;
  }
}

export function defaultCodeGraphContextRunner(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): CodeGraphRunResult {
  const candidates = process.platform === 'win32' && !path.extname(command)
    ? [command, `${command}.cmd`]
    : [command];
  let lastResult: CodeGraphRunResult = { ok: false, stdout: '', stderr: '', exitCode: null };

  for (const candidate of candidates) {
    const maxBuffer = Math.max(DEFAULT_MAX_BYTES * 4, 256 * 1024);
    const npmShimScript = process.platform === 'win32' && path.extname(candidate).toLowerCase() === '.cmd'
      ? resolveWindowsNpmShimScript(candidate)
      : undefined;
    const raw = npmShimScript
      ? spawnSync(process.execPath, [npmShimScript, ...args], {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer,
      })
      : process.platform === 'win32' && path.extname(candidate).toLowerCase() === '.cmd'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [candidate, ...args].join(' ')], {
          cwd,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer,
        })
      : spawnSync(candidate, args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer,
      });

    if (raw.error) {
      const message = raw.error.message ?? String(raw.error);
      if (/ENOENT/i.test(message) && candidate !== candidates[candidates.length - 1]) {
        lastResult = { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: message };
        continue;
      }
      return { ok: false, stdout: '', stderr: '', exitCode: null, spawnError: message };
    }

    const stdout = raw.stdout === null || raw.stdout === undefined ? '' : String(raw.stdout);
    const stderr = raw.stderr === null || raw.stderr === undefined ? '' : String(raw.stderr);
    const exitCode = raw.status ?? null;
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  }

  return lastResult;
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const suffix = '\n\n[CODEGRAPH_OUTPUT_TRUNCATED: output exceeded configured byte bound]\n';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const sliceBytes = Math.max(0, maxBytes - suffixBytes);
  return { text: buffer.subarray(0, sliceBytes).toString('utf8').replace(/\uFFFD$/, '') + suffix, truncated: true };
}

function shortReasonText(reason: string | undefined): string {
  if (reason === 'EXISTING_INDEX') return 'existing index';
  if (reason === 'DETECT_ONLY') return 'detect-only';
  return reason ?? 'unknown';
}

function summarizeFailure(run: CodeGraphRunResult, fallback: string): string {
  const raw = run.spawnError || run.stderr || run.stdout || fallback;
  const bounded = boundText(raw.trim(), 2_000).text;
  return bounded || fallback;
}

function pendingCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const record = value as Record<string, unknown>;
  return ['added', 'modified', 'removed'].reduce((sum, key) => {
    const item = record[key];
    return sum + (typeof item === 'number' && Number.isFinite(item) ? item : 0);
  }, 0);
}

function statusLooksStale(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return pendingCount(parsed.pendingChanges) > 0;
  } catch {
    return false;
  }
}

export async function buildCodeGraphContext(input: BuildCodeGraphContextInput): Promise<CodeGraphContextResult> {
  const mode = input.mode ?? 'detect-only';
  const warnings: string[] = [];
  const command = input.command ?? CODEGRAPH_COMMAND;
  const runner = input.runner ?? defaultCodeGraphContextRunner;
  const readinessProvider = input.readinessProvider ?? ((repoRoot: string) => getCodeGraphStatus(repoRoot));
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (mode === 'detect-only') {
    return { ok: true, used: false, mode, reason: 'DETECT_ONLY', warnings };
  }

  const readiness = await readinessProvider(input.repoRoot);
  warnings.push(...(Array.isArray(readiness.warnings) ? readiness.warnings : []));
  if (!readiness.available) {
    return { ok: true, used: false, mode, reason: 'CODEGRAPH_NOT_INSTALLED', warnings };
  }
  if (!readiness.initialized) {
    return { ok: true, used: false, mode, reason: 'CODEGRAPH_NOT_INITIALIZED', warnings };
  }

  const statusRun = runner(command, ['status', '--json'], input.repoRoot, timeoutMs);
  if (!statusRun.ok) {
    warnings.push(`CODEGRAPH_STATUS_FAILED: ${summarizeFailure(statusRun, 'status command failed')}`);
    return {
      ok: true,
      used: false,
      mode,
      command: [command, 'status', '--json'],
      reason: 'CODEGRAPH_STATUS_FAILED',
      warnings,
      error: { code: 'CODEGRAPH_STATUS_FAILED', message: summarizeFailure(statusRun, 'status command failed') },
    };
  }
  if (statusLooksStale(statusRun.stdout)) {
    warnings.push('CODEGRAPH_INDEX_STALE: pending changes reported by codegraph status --json; using existing index without automatic sync');
  }

  const args = [
    'context',
    input.task,
    '--path',
    input.repoRoot,
    '--max-nodes',
    '50',
    '--max-code',
    '10',
    '--format',
    'markdown',
  ];
  const contextRun = runner(command, args, input.repoRoot, timeoutMs);
  const safeCommand = [command, ...args];
  if (!contextRun.ok) {
    const message = summarizeFailure(contextRun, 'context command failed');
    warnings.push(`CODEGRAPH_CONTEXT_FAILED: ${message}`);
    return {
      ok: true,
      used: false,
      mode,
      command: safeCommand,
      reason: 'CODEGRAPH_CONTEXT_FAILED',
      warnings,
      error: { code: 'CODEGRAPH_CONTEXT_FAILED', message },
    };
  }

  const bounded = boundText(contextRun.stdout || '', maxBytes);
  if (bounded.truncated) warnings.push(`CODEGRAPH_OUTPUT_TRUNCATED: output exceeded ${maxBytes} bytes`);

  return {
    ok: true,
    used: true,
    mode,
    command: safeCommand,
    outputText: bounded.text,
    warnings,
    reason: 'EXISTING_INDEX',
  };
}

function relToAbs(runDir: string, relativePath: string): string {
  return path.join(runDir, ...relativePath.split('/'));
}

function usageJson(result: CodeGraphContextResult): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    mode: result.mode,
    used: result.used,
    reason: result.reason ?? (result.used ? 'EXISTING_INDEX' : 'UNKNOWN'),
    warnings: result.warnings,
  };
  if (result.command) usage.command = result.command;
  if (result.used) usage.artifact = CONTEXT_RELATIVE_ARTIFACT;
  if (result.error) usage.error = result.error;
  return usage;
}

export function writeCodeGraphContextArtifacts(input: {
  runDir: string;
  result: CodeGraphContextResult;
}): CodeGraphArtifactWriteResult {
  const usageArtifact = relToAbs(input.runDir, USAGE_RELATIVE_ARTIFACT);
  fs.mkdirSync(path.dirname(usageArtifact), { recursive: true });

  let contextArtifact: string | undefined;
  if (input.result.used && input.result.outputText !== undefined) {
    contextArtifact = relToAbs(input.runDir, CONTEXT_RELATIVE_ARTIFACT);
    const header = [
      '# CodeGraph Context',
      '',
      'Source: existing local CodeGraph index',
      `Mode: ${input.result.mode}`,
      `Reason: ${shortReasonText(input.result.reason)}`,
    ];
    if (input.result.command) header.push(`Command: ${input.result.command.map((part) => JSON.stringify(part)).join(' ')}`);
    header.push('', 'CodeGraph output is guidance, not source of truth. Inspect exact files before editing.', '');
    fs.writeFileSync(contextArtifact, `${header.join('\n')}\n${input.result.outputText.trim()}\n`, 'utf8');
  }

  fs.writeFileSync(usageArtifact, `${JSON.stringify(usageJson(input.result), null, 2)}\n`, 'utf8');
  return contextArtifact ? { usageArtifact, contextArtifact } : { usageArtifact };
}
