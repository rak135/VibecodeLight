import fs from 'fs';
import path from 'path';

import {
  type CodeGraphContextResult,
  type CodeGraphTransportUsed,
} from '../../adapters/codegraph/codegraph_context.js';
import { DEFAULT_CODEGRAPH_TRANSPORT } from '../../adapters/codegraph/codegraph_transport.js';

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

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const suffix = '\n\n[CODEGRAPH_OUTPUT_TRUNCATED: output exceeded configured byte bound]\n';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const sliceBytes = Math.max(0, maxBytes - suffixBytes);
  return { text: buffer.subarray(0, sliceBytes).toString('utf8').replace(/�$/, '') + suffix, truncated: true };
}

function relToAbs(runDir: string, relativePath: string): string {
  return path.join(runDir, ...relativePath.split('/'));
}

function shortReasonText(reason: string | undefined): string {
  if (reason === 'EXISTING_INDEX') return 'existing index';
  if (reason === 'DETECT_ONLY') return 'detect-only';
  return reason ?? 'unknown';
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
