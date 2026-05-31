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

export interface CodeGraphArtifactWriteResult {
  usageArtifact: string;
  contextArtifact?: string;
  /** Canonical CodeGraph-derived Repo Atlas markdown path. */
  repoAtlasArtifact?: string;
  /** Canonical CodeGraph-derived Repo Atlas JSON path. */
  repoAtlasJsonArtifact?: string;
  /** Backward-compatible legacy markdown path: scan/repo_atlas.md. */
  legacyRepoAtlasArtifact?: string;
  /** Backward-compatible legacy JSON path: scan/repo_atlas.json. */
  legacyRepoAtlasJsonArtifact?: string;
}

interface RepoAtlasItem {
  path: string;
  reason: string;
  provenance: 'codegraph_hint' | 'deterministic_scanner_fact' | 'inferred_recommendation';
  symbol?: string;
}

interface RepoAtlasJson {
  generated: boolean;
  source: {
    deterministic_scanner: string;
    codegraph: string;
    user_task: string;
  };
  limits: {
    likely_relevant_areas: number;
    candidate_entry_points: number;
    related_files_to_inspect: number;
    possible_risk_areas: number;
    unknowns: number;
  };
  sections: {
    likely_relevant_areas: RepoAtlasItem[];
    candidate_entry_points: RepoAtlasItem[];
    related_files_to_inspect: RepoAtlasItem[];
    possible_risk_areas: RepoAtlasItem[];
    unknowns: string[];
  };
  warnings: string[];
}

interface RepoAtlasBuildOptions {
  contextMarkdown: string;
  warnings: string[];
  knownRepoPaths?: Set<string>;
}

const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const CONTEXT_RELATIVE_ARTIFACT = 'scan/codegraph_context.md';
const USAGE_RELATIVE_ARTIFACT = 'scan/codegraph_usage.json';
const REPO_ATLAS_RELATIVE_ARTIFACT = 'scan/codegraph_repo_atlas.md';
const REPO_ATLAS_JSON_RELATIVE_ARTIFACT = 'scan/codegraph_repo_atlas.json';
const LEGACY_REPO_ATLAS_RELATIVE_ARTIFACT = 'scan/repo_atlas.md';
const LEGACY_REPO_ATLAS_JSON_RELATIVE_ARTIFACT = 'scan/repo_atlas.json';

const REPO_ATLAS_LIMITS = {
  likely_relevant_areas: 10,
  candidate_entry_points: 8,
  related_files_to_inspect: 10,
  possible_risk_areas: 5,
  unknowns: 5,
} as const;

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

function relToAbs(runDir: string, relativePath: string): string {
  return path.join(runDir, ...relativePath.split('/'));
}

function cleanReason(line: string): string {
  const withoutPaths = line.replace(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.@-]+(?:\.[A-Za-z0-9]+)?/g, 'referenced path');
  return boundText(withoutPaths.replace(/\s+/g, ' ').trim(), 220).text.replace(/\n\n\[CODEGRAPH_OUTPUT_TRUNCATED:[\s\S]*$/, '').trim() || 'mentioned by CodeGraph context';
}

function normalizeRepoPath(raw: string): string | undefined {
  const cleaned = raw
    .replace(/^[`'"([{<]+/, '')
    .replace(/[>`'"\])},.;:]+$/, '')
    .replace(/\\/g, '/');
  if (!cleaned.includes('/')) return undefined;
  if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) return undefined;
  if (cleaned.includes('node_modules/') || cleaned.includes('.vibecode/') || cleaned.includes('.codegraph/')) return undefined;
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  if (!segments.some((segment) => /\./.test(segment))) return undefined;
  return cleaned;
}

function pathMatches(line: string): string[] {
  const matches = line.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.@-]+(?:\.[A-Za-z0-9]+)?/g) ?? [];
  return matches.map(normalizeRepoPath).filter((item): item is string => Boolean(item));
}

function readKnownRepoPaths(runDir: string): Set<string> | undefined {
  const inventoryPath = relToAbs(runDir, 'scan/file_inventory.json');
  if (!fs.existsSync(inventoryPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as unknown;
    const records = Array.isArray(parsed)
      ? parsed
      : (typeof parsed === 'object' && parsed !== null
        ? ((parsed as { files?: Array<{ path?: unknown }>; file_inventory?: Array<{ path?: unknown }> }).files
          ?? (parsed as { files?: Array<{ path?: unknown }>; file_inventory?: Array<{ path?: unknown }> }).file_inventory
          ?? [])
        : []);
    const known = new Set(
      records
        .map((record) => (typeof record?.path === 'string' ? record.path.replace(/\\/g, '/') : ''))
        .filter((item): item is string => item.length > 0),
    );
    return known.size > 0 ? known : undefined;
  } catch {
    return undefined;
  }
}

function symbolBeforePath(line: string, filePath: string): string | undefined {
  const before = line.slice(0, line.indexOf(filePath));
  const match = before.match(/\*\*([A-Za-z_$][A-Za-z0-9_$.:-]*)\*\*\s*(?:\([^)]{1,40}\))?\s*(?:—|–|-)\s*$/)
    ?? before.match(/`([A-Za-z_$][A-Za-z0-9_$.:-]*)`\s*(?:\([^)]{1,40}\))?\s*(?:—|–|-)\s*$/);
  return match?.[1];
}

function cleanSymbolHint(symbol: string | undefined): string | undefined {
  const cleaned = symbol?.replace(/:\d+$/, '').trim();
  return cleaned && cleaned.length <= 80 ? cleaned : undefined;
}

function symbolNearPath(line: string, filePath: string): string | undefined {
  const after = line.slice(line.indexOf(filePath) + filePath.length);
  const match = after.match(/\s*(?:::|#|->|→|:)\s*`?([A-Za-z_$][A-Za-z0-9_$.:-]*)`?/)
    ?? after.match(/\s*(?:—|–|-)\s*`?([A-Za-z_$][A-Za-z0-9_$.:-]*)`?/);
  return cleanSymbolHint(match?.[1] ?? symbolBeforePath(line, filePath));
}

type CodeGraphMarkdownSection = 'entry_points' | 'related_symbols';

function normalizeMarkdownHeading(line: string): string | undefined {
  const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
  if (!match) return undefined;
  return match[1]
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function codeGraphMarkdownSection(line: string): CodeGraphMarkdownSection | undefined {
  const heading = normalizeMarkdownHeading(line);
  if (heading === 'entry points') return 'entry_points';
  if (heading === 'related symbols') return 'related_symbols';
  return undefined;
}

function atlasBucketForLine(line: string, section: CodeGraphMarkdownSection | undefined): keyof RepoAtlasJson['sections'] {
  if (section === 'entry_points') return 'candidate_entry_points';
  if (section === 'related_symbols') return 'related_files_to_inspect';
  return classifyAtlasLine(line);
}

function reasonForAtlasItem(line: string, filePath: string, section: CodeGraphMarkdownSection | undefined): string {
  const symbol = symbolNearPath(line, filePath);
  if (section === 'entry_points') return symbol ? `entry point: ${symbol}` : 'entry point hint from CodeGraph';
  if (section === 'related_symbols') return symbol ? `related symbol: ${symbol}` : 'related symbol hint from CodeGraph';
  return cleanReason(line);
}

function classifyAtlasLine(line: string): keyof RepoAtlasJson['sections'] {
  const lower = line.toLowerCase();
  if (/\b(entry|entrypoint|main|cli|command|route|handler|ipc|bootstrap|startup)\b/.test(lower)) return 'candidate_entry_points';
  if (/\b(risk|warning|caution|danger|stale|generated|migration|break|fragile)\b/.test(lower)) return 'possible_risk_areas';
  if (/\b(related|nearby|neighbor|import|imports|depend|dependency|calls|called|uses|references|test)\b/.test(lower)) return 'related_files_to_inspect';
  return 'likely_relevant_areas';
}

function addAtlasItem(
  buckets: RepoAtlasJson['sections'],
  seen: Set<string>,
  seenByBucket: Map<string, Set<keyof RepoAtlasJson['sections']>>,
  bucket: keyof RepoAtlasJson['sections'],
  item: RepoAtlasItem,
  options: { allowCrossBucketDuplicate?: boolean } = {},
): void {
  if (bucket === 'unknowns') return;
  const previousBuckets = seenByBucket.get(item.path);
  if (previousBuckets?.has(bucket)) return;
  if (!options.allowCrossBucketDuplicate && seen.has(item.path)) return;
  const limits = REPO_ATLAS_LIMITS;
  if (buckets[bucket].length >= limits[bucket]) return;
  seen.add(item.path);
  const nextBuckets = previousBuckets ?? new Set<keyof RepoAtlasJson['sections']>();
  nextBuckets.add(bucket);
  seenByBucket.set(item.path, nextBuckets);
  buckets[bucket].push(item);
}

function emptyRepoAtlasSections(): RepoAtlasJson['sections'] {
  return {
    likely_relevant_areas: [],
    candidate_entry_points: [],
    related_files_to_inspect: [],
    possible_risk_areas: [],
    unknowns: [],
  };
}

function buildRepoAtlasFromCodeGraphContext(input: RepoAtlasBuildOptions): RepoAtlasJson {
  const sections = emptyRepoAtlasSections();
  const seen = new Set<string>();
  const seenByBucket = new Map<string, Set<keyof RepoAtlasJson['sections']>>();
  const lines = input.contextMarkdown.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 400);

  let currentSection: CodeGraphMarkdownSection | undefined;

  for (const line of lines) {
    if (normalizeMarkdownHeading(line) !== undefined) {
      currentSection = codeGraphMarkdownSection(line);
      continue;
    }
    const paths = pathMatches(line).filter((filePath) => {
      if (!input.knownRepoPaths) return true;
      return input.knownRepoPaths.has(filePath);
    });
    if (paths.length === 0) continue;
    const bucket = atlasBucketForLine(line, currentSection);
    for (const filePath of paths) {
      const symbol = symbolNearPath(line, filePath);
      addAtlasItem(sections, seen, seenByBucket, bucket, {
        path: filePath,
        reason: reasonForAtlasItem(line, filePath, currentSection),
        provenance: currentSection === 'entry_points' || currentSection === 'related_symbols' || bucket === 'related_files_to_inspect'
          ? 'codegraph_hint'
          : bucket === 'candidate_entry_points' || bucket === 'possible_risk_areas'
            ? 'inferred_recommendation'
            : 'codegraph_hint',
        ...(symbol ? { symbol } : {}),
      }, { allowCrossBucketDuplicate: currentSection === 'entry_points' || currentSection === 'related_symbols' });
    }
  }

  if (seen.size === 0) {
    sections.unknowns.push('CodeGraph context did not expose recognizable bounded repository paths; inspect scan/codegraph_context.md and exact source files before editing.');
  }
  if (sections.candidate_entry_points.length === 0) {
    sections.unknowns.push('Candidate entry points were not confidently identified from CodeGraph hints; verify deterministic scanner entrypoints and source files.');
  }
  if (sections.related_files_to_inspect.length === 0) {
    sections.unknowns.push('Nearby relationship hints were sparse; use deterministic imports/symbols artifacts and source inspection before editing.');
  }
  sections.unknowns = sections.unknowns.slice(0, REPO_ATLAS_LIMITS.unknowns);

  return {
    generated: true,
    source: {
      deterministic_scanner: 'Scanner facts and saved run artifacts remain source of truth for repository files and generated artifact locations.',
      codegraph: 'CodeGraph-derived hints from existing local index via scan/codegraph_context.md.',
      user_task: 'Task text only guides relevance; it is not proof that a file must be changed.',
    },
    limits: { ...REPO_ATLAS_LIMITS },
    sections,
    warnings: [...input.warnings],
  };
}

function renderAtlasItems(items: RepoAtlasItem[], fallback: string): string[] {
  if (items.length === 0) return [`- ${fallback}`];
  return items.map((item) => {
    const symbol = item.symbol ? `/${item.symbol}` : '';
    return `- ${item.path}${symbol} — ${item.reason} (${item.provenance})`;
  });
}

function renderRepoAtlasMarkdown(atlas: RepoAtlasJson): string {
  const parts: string[] = [
    '# Repo Atlas',
    '',
    'Source:',
    '- Deterministic scanner facts: saved scan artifacts remain source of truth for exact paths and files.',
    '- CodeGraph existing local index: hints derived from bounded scan/codegraph_context.md.',
    '- User task: used only to frame relevance.',
    '',
    'Important note:',
    'CodeGraph output is guidance, not source of truth. CodeGraph-derived hints and inferred recommendations are not verified facts. Inspect exact files before editing.',
    '',
    '## Likely Relevant Areas',
    ...renderAtlasItems(atlas.sections.likely_relevant_areas, 'not confidently identified from CodeGraph hints'),
    '',
    '## Candidate Entry Points',
    ...renderAtlasItems(atlas.sections.candidate_entry_points, 'not confidently identified from CodeGraph hints'),
    '',
    '## Related Files To Inspect',
    ...renderAtlasItems(atlas.sections.related_files_to_inspect, 'not confidently identified from CodeGraph hints'),
    '',
    '## Possible Risk Areas',
    ...renderAtlasItems(atlas.sections.possible_risk_areas, 'none highlighted by bounded CodeGraph hints'),
    '',
    '## Unknowns / Must Verify',
    ...(atlas.sections.unknowns.length > 0 ? atlas.sections.unknowns.map((item) => `- ${item}`) : ['- Inspect source files and deterministic scanner artifacts before editing.']),
  ];
  if (atlas.warnings.length > 0) {
    parts.push('', '## CodeGraph Warnings', ...atlas.warnings.slice(0, 5).map((warning) => `- ${warning}`));
  }
  return boundText(parts.join('\n'), 12_000).text;
}

function repoAtlasUsageFields(generated: boolean, reason: string): Record<string, unknown> {
  return generated
    ? {
      codegraph_repo_atlas_generated: true,
      codegraph_repo_atlas_reason: reason,
      codegraph_repo_atlas_artifact: REPO_ATLAS_RELATIVE_ARTIFACT,
      codegraph_repo_atlas_json_artifact: REPO_ATLAS_JSON_RELATIVE_ARTIFACT,
      repo_atlas_generated: true,
      repo_atlas_reason: reason,
      repo_atlas_artifact: LEGACY_REPO_ATLAS_RELATIVE_ARTIFACT,
      repo_atlas_json_artifact: LEGACY_REPO_ATLAS_JSON_RELATIVE_ARTIFACT,
    }
    : {
      codegraph_repo_atlas_generated: false,
      codegraph_repo_atlas_reason: reason,
      repo_atlas_generated: false,
      repo_atlas_reason: reason,
    };
}

function repoAtlasSkippedReason(result: CodeGraphContextResult): string {
  if (result.used) return 'NO_RECOGNIZABLE_CODEGRAPH_PATHS';
  if (result.reason === 'DETECT_ONLY' || result.mode === 'detect-only') return 'detect-only';
  return result.reason ?? 'CODEGRAPH_NOT_USED';
}

function usageJson(result: CodeGraphContextResult, atlas?: { generated: boolean; reason: string }): Record<string, unknown> {
  const transportRequested = result.transportRequested ?? DEFAULT_CODEGRAPH_TRANSPORT;
  const transportUsed: CodeGraphTransportUsed = result.transportUsed
    ?? (result.used ? (transportRequested === 'auto' ? 'cli' : transportRequested) : 'none');
  const usage: Record<string, unknown> = {
    mode: result.mode,
    used: result.used,
    used_for_context: result.used,
    transport_requested: transportRequested,
    transport_used: transportUsed,
    mcp_attempted: result.mcpAttempted ?? false,
    fallback_used: result.fallbackUsed ?? false,
    reason: result.reason ?? (result.used ? 'EXISTING_INDEX' : 'UNKNOWN'),
    warnings: result.warnings,
  };
  if (result.fallbackReason) usage.fallback_reason = result.fallbackReason;
  if (result.command) usage.command = result.command;
  if (result.used) {
    usage.artifact = CONTEXT_RELATIVE_ARTIFACT;
    usage.context_artifact = CONTEXT_RELATIVE_ARTIFACT;
  }
  Object.assign(usage, repoAtlasUsageFields(atlas?.generated === true, atlas?.reason ?? repoAtlasSkippedReason(result)));
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
  let repoAtlasArtifact: string | undefined;
  let repoAtlasJsonArtifact: string | undefined;
  let legacyRepoAtlasArtifact: string | undefined;
  let legacyRepoAtlasJsonArtifact: string | undefined;
  let atlasUsage: { generated: boolean; reason: string } | undefined;
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
    const contextMarkdown = `${header.join('\n')}\n${input.result.outputText.trim()}\n`;
    fs.writeFileSync(contextArtifact, contextMarkdown, 'utf8');

    const atlas = buildRepoAtlasFromCodeGraphContext({
      contextMarkdown,
      warnings: input.result.warnings,
      knownRepoPaths: readKnownRepoPaths(input.runDir),
    });
    repoAtlasArtifact = relToAbs(input.runDir, REPO_ATLAS_RELATIVE_ARTIFACT);
    repoAtlasJsonArtifact = relToAbs(input.runDir, REPO_ATLAS_JSON_RELATIVE_ARTIFACT);
    legacyRepoAtlasArtifact = relToAbs(input.runDir, LEGACY_REPO_ATLAS_RELATIVE_ARTIFACT);
    legacyRepoAtlasJsonArtifact = relToAbs(input.runDir, LEGACY_REPO_ATLAS_JSON_RELATIVE_ARTIFACT);
    const atlasMarkdown = `${renderRepoAtlasMarkdown(atlas).trim()}\n`;
    const atlasJson = `${JSON.stringify(atlas, null, 2)}\n`;
    fs.writeFileSync(repoAtlasArtifact, atlasMarkdown, 'utf8');
    fs.writeFileSync(repoAtlasJsonArtifact, atlasJson, 'utf8');
    fs.writeFileSync(legacyRepoAtlasArtifact, atlasMarkdown, 'utf8');
    fs.writeFileSync(legacyRepoAtlasJsonArtifact, atlasJson, 'utf8');
    atlasUsage = { generated: true, reason: 'generated' };
  }

  fs.writeFileSync(usageArtifact, `${JSON.stringify(usageJson(input.result, atlasUsage), null, 2)}\n`, 'utf8');
  return {
    usageArtifact,
    ...(contextArtifact ? { contextArtifact } : {}),
    ...(repoAtlasArtifact ? { repoAtlasArtifact } : {}),
    ...(repoAtlasJsonArtifact ? { repoAtlasJsonArtifact } : {}),
    ...(legacyRepoAtlasArtifact ? { legacyRepoAtlasArtifact } : {}),
    ...(legacyRepoAtlasJsonArtifact ? { legacyRepoAtlasJsonArtifact } : {}),
  };
}
