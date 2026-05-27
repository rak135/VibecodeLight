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
  repoAtlasArtifact?: string;
  repoAtlasJsonArtifact?: string;
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
const REPO_ATLAS_RELATIVE_ARTIFACT = 'scan/repo_atlas.md';
const REPO_ATLAS_JSON_RELATIVE_ARTIFACT = 'scan/repo_atlas.json';

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

function symbolNearPath(line: string, filePath: string): string | undefined {
  const after = line.slice(line.indexOf(filePath) + filePath.length);
  const match = after.match(/\s*(?:::|#|->|→)\s*([A-Za-z_$][A-Za-z0-9_$.:-]*)/);
  return match?.[1];
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
  bucket: keyof RepoAtlasJson['sections'],
  item: RepoAtlasItem,
): void {
  if (bucket === 'unknowns') return;
  if (seen.has(item.path)) return;
  const limits = REPO_ATLAS_LIMITS;
  if (buckets[bucket].length >= limits[bucket]) return;
  seen.add(item.path);
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
  const lines = input.contextMarkdown.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 400);

  for (const line of lines) {
    const paths = pathMatches(line).filter((filePath) => {
      if (!input.knownRepoPaths) return true;
      return input.knownRepoPaths.has(filePath);
    });
    if (paths.length === 0) continue;
    const bucket = classifyAtlasLine(line);
    for (const filePath of paths) {
      addAtlasItem(sections, seen, bucket, {
        path: filePath,
        reason: cleanReason(line),
        provenance: bucket === 'candidate_entry_points' || bucket === 'possible_risk_areas'
          ? 'inferred_recommendation'
          : 'codegraph_hint',
        ...(symbolNearPath(line, filePath) ? { symbol: symbolNearPath(line, filePath) } : {}),
      });
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
      repo_atlas_generated: true,
      repo_atlas_reason: reason,
      repo_atlas_artifact: REPO_ATLAS_RELATIVE_ARTIFACT,
      repo_atlas_json_artifact: REPO_ATLAS_JSON_RELATIVE_ARTIFACT,
    }
    : {
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
  const usage: Record<string, unknown> = {
    mode: result.mode,
    used: result.used,
    reason: result.reason ?? (result.used ? 'EXISTING_INDEX' : 'UNKNOWN'),
    warnings: result.warnings,
  };
  if (result.command) usage.command = result.command;
  if (result.used) usage.artifact = CONTEXT_RELATIVE_ARTIFACT;
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
    fs.writeFileSync(repoAtlasArtifact, `${renderRepoAtlasMarkdown(atlas).trim()}\n`, 'utf8');
    fs.writeFileSync(repoAtlasJsonArtifact, `${JSON.stringify(atlas, null, 2)}\n`, 'utf8');
    atlasUsage = { generated: true, reason: 'generated' };
  }

  fs.writeFileSync(usageArtifact, `${JSON.stringify(usageJson(input.result, atlasUsage), null, 2)}\n`, 'utf8');
  return {
    usageArtifact,
    ...(contextArtifact ? { contextArtifact } : {}),
    ...(repoAtlasArtifact ? { repoAtlasArtifact } : {}),
    ...(repoAtlasJsonArtifact ? { repoAtlasJsonArtifact } : {}),
  };
}
