import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { CODEGRAPH_COMMAND } from './codegraph_cli.js';
import { getCodeGraphStatus, type CodeGraphStatusResult, type CodeGraphRunResult } from './codegraph_actions.js';
import {
  buildCodeGraphMcpContext,
  type CodeGraphMcpContextRunner,
} from './codegraph_mcp.js';
import {
  DEFAULT_CODEGRAPH_TRANSPORT,
  type CodeGraphTransport,
} from './codegraph_transport.js';

export type CodeGraphContextMode = 'detect-only' | 'use-existing';

/**
 * Which transport actually produced the CodeGraph context, or `none` when
 * context was not queried (detect-only, or use-existing failures that did not
 * yield context). Recorded in `scan/codegraph_usage.json` alongside the
 * requested transport.
 */
export type CodeGraphTransportUsed = CodeGraphTransport | 'none';

export interface CodeGraphContextResult {
  ok: boolean;
  used: boolean;
  mode: CodeGraphContextMode;
  command?: string[];
  artifact?: string;
  outputText?: string;
  warnings: string[];
  reason?: string;
  /**
   * Transport requested by the caller (cli/mcp/auto). Defaults to cli when
   * absent. Optional in the type for back-compat with test fixtures and older
   * call sites that pre-date Phase 1B.
   */
  transportRequested?: CodeGraphTransport;
  /**
   * Transport that actually built the context, or 'none' when nothing did.
   * Optional for back-compat; the usage writer defaults to 'cli' if used and
   * 'none' otherwise.
   */
  transportUsed?: CodeGraphTransportUsed;
  /** True when the MCP transport was attempted (auto or mcp). */
  mcpAttempted?: boolean;
  /** True when MCP was attempted and the run fell back to the CLI transport. */
  fallbackUsed?: boolean;
  /** Optional human-readable explanation of why the fallback happened. */
  fallbackReason?: string;
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
  /** Pipeline transport selection (defaults to cli). */
  transport?: CodeGraphTransport;
  maxBytes?: number;
  timeoutMs?: number;
  command?: string;
  runner?: CodeGraphContextRunner;
  readinessProvider?: CodeGraphReadinessProvider;
  /** Test seam for the MCP transport. */
  mcpRunner?: CodeGraphMcpContextRunner;
}

const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

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
  return { text: buffer.subarray(0, sliceBytes).toString('utf8').replace(/�$/, '') + suffix, truncated: true };
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

interface CliTransportContext {
  command: string;
  runner: CodeGraphContextRunner;
  readinessProvider: CodeGraphReadinessProvider;
  maxBytes: number;
  timeoutMs: number;
}

interface CliTransportPartial {
  used: boolean;
  command?: string[];
  outputText?: string;
  warnings: string[];
  reason?: string;
  error?: { code: string; message: string };
}

async function runCliTransport(
  input: BuildCodeGraphContextInput,
  ctx: CliTransportContext,
): Promise<CliTransportPartial> {
  const warnings: string[] = [];
  const readiness = await ctx.readinessProvider(input.repoRoot);
  warnings.push(...(Array.isArray(readiness.warnings) ? readiness.warnings : []));
  if (!readiness.available) {
    return { used: false, reason: 'CODEGRAPH_NOT_INSTALLED', warnings };
  }
  if (!readiness.initialized) {
    return { used: false, reason: 'CODEGRAPH_NOT_INITIALIZED', warnings };
  }

  const statusRun = ctx.runner(ctx.command, ['status', '--json'], input.repoRoot, ctx.timeoutMs);
  if (!statusRun.ok) {
    const message = summarizeFailure(statusRun, 'status command failed');
    warnings.push(`CODEGRAPH_STATUS_FAILED: ${message}`);
    return {
      used: false,
      command: [ctx.command, 'status', '--json'],
      reason: 'CODEGRAPH_STATUS_FAILED',
      warnings,
      error: { code: 'CODEGRAPH_STATUS_FAILED', message },
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
  const contextRun = ctx.runner(ctx.command, args, input.repoRoot, ctx.timeoutMs);
  const safeCommand = [ctx.command, ...args];
  if (!contextRun.ok) {
    const message = summarizeFailure(contextRun, 'context command failed');
    warnings.push(`CODEGRAPH_CONTEXT_FAILED: ${message}`);
    return {
      used: false,
      command: safeCommand,
      reason: 'CODEGRAPH_CONTEXT_FAILED',
      warnings,
      error: { code: 'CODEGRAPH_CONTEXT_FAILED', message },
    };
  }

  const bounded = boundText(contextRun.stdout || '', ctx.maxBytes);
  if (bounded.truncated) warnings.push(`CODEGRAPH_OUTPUT_TRUNCATED: output exceeded ${ctx.maxBytes} bytes`);

  return {
    used: true,
    command: safeCommand,
    outputText: bounded.text,
    warnings,
    reason: 'EXISTING_INDEX',
  };
}

interface McpTransportPartial {
  used: boolean;
  outputText?: string;
  warnings: string[];
  reason?: string;
  command?: string[];
  error?: { code: string; message: string };
}

async function runMcpTransport(
  input: BuildCodeGraphContextInput,
  ctx: { command: string; maxBytes: number; timeoutMs: number; mcpRunner?: CodeGraphMcpContextRunner },
): Promise<McpTransportPartial> {
  const warnings: string[] = [];
  const mcpResult = await buildCodeGraphMcpContext({
    repoRoot: input.repoRoot,
    task: input.task,
    command: ctx.command,
    timeoutMs: ctx.timeoutMs,
    maxNodes: 50,
    maxCode: 10,
    ...(ctx.mcpRunner ? { runner: ctx.mcpRunner } : {}),
  });
  warnings.push(...mcpResult.warnings);
  const safeCommand = [ctx.command, 'serve', '--mcp'];
  if (!mcpResult.ok) {
    const code = mcpResult.error?.code ?? 'CODEGRAPH_MCP_CONTEXT_FAILED';
    const message = mcpResult.error?.message ?? 'CodeGraph MCP context failed';
    warnings.push(`${code}: ${message}`);
    return {
      used: false,
      command: safeCommand,
      reason: code,
      warnings,
      error: { code, message },
    };
  }
  const bounded = boundText(mcpResult.text ?? '', ctx.maxBytes);
  if (bounded.truncated) warnings.push(`CODEGRAPH_OUTPUT_TRUNCATED: output exceeded ${ctx.maxBytes} bytes`);
  return {
    used: true,
    command: safeCommand,
    outputText: bounded.text,
    warnings,
    reason: 'EXISTING_INDEX',
  };
}

export async function buildCodeGraphContext(input: BuildCodeGraphContextInput): Promise<CodeGraphContextResult> {
  const mode = input.mode ?? 'detect-only';
  const transportRequested: CodeGraphTransport = input.transport ?? DEFAULT_CODEGRAPH_TRANSPORT;
  const command = input.command ?? CODEGRAPH_COMMAND;
  const runner = input.runner ?? defaultCodeGraphContextRunner;
  const readinessProvider = input.readinessProvider ?? ((repoRoot: string) => getCodeGraphStatus(repoRoot));
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (mode === 'detect-only') {
    return {
      ok: true,
      used: false,
      mode,
      reason: 'DETECT_ONLY',
      warnings: [],
      transportRequested,
      transportUsed: 'none',
      mcpAttempted: false,
      fallbackUsed: false,
    };
  }

  if (transportRequested === 'cli') {
    const cli = await runCliTransport(input, {
      command,
      runner,
      readinessProvider,
      maxBytes,
      timeoutMs,
    });
    return finalizeResult(cli, {
      mode,
      transportRequested,
      transportUsed: cli.used ? 'cli' : 'none',
      mcpAttempted: false,
      fallbackUsed: false,
    });
  }

  if (transportRequested === 'mcp') {
    const mcp = await runMcpTransport(input, {
      command,
      maxBytes,
      timeoutMs,
      ...(input.mcpRunner ? { mcpRunner: input.mcpRunner } : {}),
    });
    return finalizeResult(mcp, {
      mode,
      transportRequested,
      transportUsed: mcp.used ? 'mcp' : 'none',
      mcpAttempted: true,
      fallbackUsed: false,
    });
  }

  // transport === 'auto': prefer MCP; fall back to CLI on MCP failure.
  const mcp = await runMcpTransport(input, {
    command,
    maxBytes,
    timeoutMs,
    ...(input.mcpRunner ? { mcpRunner: input.mcpRunner } : {}),
  });
  if (mcp.used) {
    return finalizeResult(mcp, {
      mode,
      transportRequested,
      transportUsed: 'mcp',
      mcpAttempted: true,
      fallbackUsed: false,
    });
  }
  const fallbackReason = mcp.error?.message
    ? `MCP context failed; fell back to CLI. ${mcp.error.code}: ${mcp.error.message}`
    : 'MCP context failed; fell back to CLI.';
  const cli = await runCliTransport(input, {
    command,
    runner,
    readinessProvider,
    maxBytes,
    timeoutMs,
  });
  const mergedWarnings = [
    ...mcp.warnings,
    'CodeGraph MCP failed; fell back to CLI.',
    ...cli.warnings,
  ];
  const merged: CliTransportPartial = {
    used: cli.used,
    warnings: mergedWarnings,
    ...(cli.command ? { command: cli.command } : {}),
    ...(cli.outputText !== undefined ? { outputText: cli.outputText } : {}),
    ...(cli.reason ? { reason: cli.reason } : {}),
    ...(cli.error ? { error: cli.error } : {}),
  };
  return finalizeResult(merged, {
    mode,
    transportRequested,
    transportUsed: cli.used ? 'cli' : 'none',
    mcpAttempted: true,
    fallbackUsed: true,
    fallbackReason,
  });
}

function finalizeResult(
  partial: CliTransportPartial | McpTransportPartial,
  meta: {
    mode: CodeGraphContextMode;
    transportRequested: CodeGraphTransport;
    transportUsed: CodeGraphTransportUsed;
    mcpAttempted: boolean;
    fallbackUsed: boolean;
    fallbackReason?: string;
  },
): CodeGraphContextResult {
  return {
    ok: true,
    used: partial.used,
    mode: meta.mode,
    warnings: partial.warnings,
    transportRequested: meta.transportRequested,
    transportUsed: meta.transportUsed,
    mcpAttempted: meta.mcpAttempted,
    fallbackUsed: meta.fallbackUsed,
    ...(partial.command ? { command: partial.command } : {}),
    ...(partial.outputText !== undefined ? { outputText: partial.outputText } : {}),
    ...(partial.reason ? { reason: partial.reason } : {}),
    ...(partial.error ? { error: partial.error } : {}),
    ...(meta.fallbackReason ? { fallbackReason: meta.fallbackReason } : {}),
  };
}

export {
  writeCodeGraphContextArtifacts,
  type CodeGraphArtifactWriteResult,
} from '../../core/runs/codegraph_artifacts.js';
