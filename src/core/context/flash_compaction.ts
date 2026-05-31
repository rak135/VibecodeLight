import fs from 'fs';
import path from 'path';

import type { TaskIntent } from '../../adapters/task_normalizer/types.js';
import { readSavedArtifact } from './artifact_reader.js';
import { FLASH_INPUT_OPTIONAL_INPUTS, FlashInputManifestError } from './flash_input_manifest.js';

export const FLASH_INPUT_TARGET_TOKENS = 24_000;
export const FLASH_INPUT_HARD_MAX_TOKENS = 32_000;
export const REPO_ATLAS_HARD_MAX_TOKENS = 12_000;
export const TASK_SLICE_HARD_MAX_TOKENS = 24_000;

export interface CompactFlashArtifacts {
  flashInput: string;
  repoAtlas: string;
  taskSlice: string;
  relevanceSelection: RelevanceSelection;
  budget: FlashInputBudget;
  paths: CompactFlashArtifactPaths;
}

export interface CompactFlashArtifactPaths {
  repo_atlas_path?: string;
  run_repo_atlas_path: string;
  task_slice_path: string;
  relevance_selection_path: string;
  flash_input_budget_path: string;
}

export interface BuildCompactFlashContextOptions {
  run_id: string;
  task: string;
  repo_root: string;
  runDir: string;
  previousRunSummary?: string | undefined;
  taskIntent?: TaskIntent;
}

interface ScoredPath {
  path: string;
  score: number;
  reasons: string[];
}

export interface RelevanceSelection {
  selected_files: ScoredPath[];
  selected_tests: ScoredPath[];
  selected_docs: ScoredPath[];
  selected_symbols: { count: number; reasons: string[]; symbols: Array<Record<string, unknown>> };
  selected_import_edges: { count: number; reasons: string[]; edges: Array<Record<string, unknown>> };
  excluded_large_sections: string[];
  full_artifacts_referenced: string[];
}

export interface FlashInputBudget {
  target_tokens: number;
  hard_max_tokens: number;
  estimated_tokens: number;
  estimated_chars: number;
  section_breakdown: Array<{ title: string; estimated_tokens: number; estimated_chars: number }>;
  included_sections: string[];
  summarized_sections: string[];
  excluded_sections: string[];
  full_artifacts_referenced: string[];
  provider_called: boolean;
  budget_status: 'ok' | 'FLASH_INPUT_BUDGET_EXCEEDED';
}

export class FlashInputBudgetError extends FlashInputManifestError {
  constructor(message: string, pathValue: string, details: string[] = []) {
    super('FLASH_INPUT_BUDGET_EXCEEDED', message, pathValue, details);
    this.name = 'FlashInputBudgetError';
  }
}

export const FULL_ARTIFACT_REFERENCES = [
  'scanner_config.json',
  'scan/scan_manifest.json',
  'scan/repo_tree.txt',
  'scan/file_inventory.json',
  'scan/git_status.json',
  'scan/git_diff_stat.txt',
  'scan/ignore_rules.json',
  'scan/config_snapshot.json',
  'scan/manifests.json',
  'scan/environment.json',
  'scan/commands.json',
  'scan/tooling.json',
  'scan/repo_instructions.json',
  'scan/docs.json',
  'scan/architecture_docs.json',
  'scan/symbols.json',
  'scan/imports.json',
  'scan/entrypoints.json',
  'scan/tests.json',
  'scan/schemas.json',
  'scan/exact_text_hits.json',
  'scan/keyword_hits.json',
  'scan/recent_history.json',
  'skills/skills_catalog.json',
];

const CODEGRAPH_CONTEXT_REFERENCE = 'scan/codegraph_context.md';
const CODEGRAPH_REPO_ATLAS_REFERENCE = 'scan/codegraph_repo_atlas.md';
const CODEGRAPH_REPO_ATLAS_JSON_REFERENCE = 'scan/codegraph_repo_atlas.json';
const LEGACY_CODEGRAPH_REPO_ATLAS_REFERENCE = 'scan/repo_atlas.md';
const LEGACY_CODEGRAPH_REPO_ATLAS_JSON_REFERENCE = 'scan/repo_atlas.json';

const SUBSYSTEMS = [
  { name: 'CLI', paths: ['src/app/cli'] },
  { name: 'Desktop', paths: ['src/app/desktop'] },
  { name: 'Prompting Pipeline', paths: ['src/core/prompting', 'src/core/context'] },
  { name: 'Config', paths: ['src/core/config'] },
  { name: 'LLM Adapters', paths: ['src/adapters/llm'] },
  { name: 'Scanner', paths: ['src/core/scanning'] },
  { name: 'Skills', paths: ['src/core/skills', 'SKILLS'] },
  { name: 'Terminal/PTY', paths: ['src/core/terminal', 'src/adapters/pty', 'src/app/desktop/renderer'] },
  { name: 'Tests', paths: ['tests'] },
  { name: 'Docs', paths: ['docs', 'README.md', 'AGENTS.md'] },
];

const VALIDATION_COMMANDS = [
  'pnpm test',
  'pnpm test:serial',
  'pnpm exec tsc --noEmit',
  'pnpm exec tsc --project tsconfig.desktop.json',
  'pnpm lint',
  'cd src/core/scanning/python && uv run pytest',
  'cd src/core/scanning/python && uv run ruff check .',
];

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function readJson(runDir: string, relPath: string): unknown {
  const raw = readSavedArtifact(runDir, relPath);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function readText(runDir: string, relPath: string): string {
  return readSavedArtifact(runDir, relPath) ?? '';
}

function asRecords(value: unknown, preferredKeys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
  if (typeof value !== 'object' || value === null) return [];
  const obj = value as Record<string, unknown>;
  for (const key of preferredKeys) {
    const nested = obj[key];
    if (Array.isArray(nested)) return nested.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
  }
  return [];
}

function getPath(record: Record<string, unknown>): string {
  return typeof record.path === 'string' ? record.path.replace(/\\/g, '/') : '';
}

function getString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk|pk|ghp|github_pat|hf)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [REDACTED]');
}

function truncate(text: string, maxChars: number): string {
  const safe = redactSecrets(text.trim());
  if (safe.length <= maxChars) return safe;
  return `${safe.slice(0, maxChars).trimEnd()}\n… truncated`;
}

function taskTokens(task: string): string[] {
  const stop = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'into', 'must', 'should', 'user', 'task', 'fix', 'use', 'not', 'all', 'run', 'runs', 'when', 'where', 'what']);
  return unique(
    task
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stop.has(token)),
  );
}

function scorePath(
  filePath: string,
  tokens: string[],
  hintBoosts: Map<string, string[]>,
  extraReason?: string,
  exactReasons: string[] = [],
): ScoredPath {
  const lower = filePath.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (exactReasons.length > 0) {
    score += 100_000;
    if (!/(^|\/)tests?\//.test(filePath) && !/\.test\./.test(filePath) && !/\.spec\./.test(filePath)) {
      score += 1_000;
    }
    reasons.push(...exactReasons);
  }
  for (const token of tokens) {
    if (lower.includes(token)) {
      score += 10;
      reasons.push(`path matches task term '${token}'`);
      reasons.push(...(hintBoosts.get(token) ?? []));
    }
  }
  if (lower.includes('flash') || lower.includes('context')) {
    score += 8;
    reasons.push('context/flash area');
  }
  if (lower.includes('prompt')) {
    score += 6;
    reasons.push('prompt pipeline area');
  }
  if (lower.includes('test')) {
    score += 3;
    reasons.push('test path');
  }
  if (extraReason) {
    score += 12;
    reasons.push(extraReason);
  }
  return { path: filePath, score, reasons: unique(reasons) };
}

function sortedTop(items: ScoredPath[], limit: number): ScoredPath[] {
  return items
    .filter((item) => item.path)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function collectInventoryPaths(runDir: string): string[] {
  const records = asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.file_inventory), ['files', 'file_inventory']);
  return records.map(getPath).filter(Boolean);
}

function collectKeywordBoosts(runDir: string): Map<string, string> {
  const records = asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.keyword_hits), ['keyword_hits', 'hits']);
  const boosts = new Map<string, string>();
  for (const record of records.slice(0, 50)) {
    const filePath = getPath(record);
    if (filePath && !boosts.has(filePath)) boosts.set(filePath, `keyword hit: ${getString(record, 'match_type') || 'task match'}`);
  }
  return boosts;
}

function collectExactTextReasons(runDir: string): Map<string, string[]> {
  const records = asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.exact_text_hits), ['exact_text_hits', 'hits']);
  const reasons = new Map<string, string[]>();
  for (const record of records.slice(0, 50)) {
    const filePath = getPath(record);
    if (!filePath) continue;
    const term = getString(record, 'term') || getString(record, 'normalized_term') || getString(record, 'keyword');
    const reason = term
      ? `exact text match: "${truncate(term, 180).replace(/\n/g, ' ')}"`
      : 'exact text match';
    reasons.set(filePath, unique([...(reasons.get(filePath) ?? []), reason]));
  }
  return reasons;
}

function collectHintBoosts(taskIntent?: TaskIntent): Map<string, string[]> {
  const boosts = new Map<string, string[]>();
  if (!taskIntent?.enabled || !taskIntent.ok) return boosts;

  const addBoost = (token: string, reason: string): void => {
    if (!token) return;
    boosts.set(token, unique([...(boosts.get(token) ?? []), reason]));
  };

  for (const hint of taskIntent.search_hints) {
    for (const token of taskTokens(hint)) addBoost(token, `matched search hint: ${hint}`);
  }

  for (const [groupName, terms] of Object.entries(taskIntent.keyword_groups)) {
    for (const term of terms) {
      for (const token of taskTokens(term)) addBoost(token, `matched keyword group: ${groupName}`);
    }
  }

  return boosts;
}

function codeGraphContextArtifactExists(runDir: string): boolean {
  return fs.existsSync(path.join(runDir, ...CODEGRAPH_CONTEXT_REFERENCE.split('/')));
}

function codeGraphRepoAtlasArtifactReference(runDir: string): string | undefined {
  if (fs.existsSync(path.join(runDir, ...CODEGRAPH_REPO_ATLAS_REFERENCE.split('/')))) return CODEGRAPH_REPO_ATLAS_REFERENCE;
  if (fs.existsSync(path.join(runDir, ...LEGACY_CODEGRAPH_REPO_ATLAS_REFERENCE.split('/')))) return LEGACY_CODEGRAPH_REPO_ATLAS_REFERENCE;
  return undefined;
}

function codeGraphRepoAtlasJsonArtifactReference(runDir: string): string | undefined {
  if (fs.existsSync(path.join(runDir, ...CODEGRAPH_REPO_ATLAS_JSON_REFERENCE.split('/')))) return CODEGRAPH_REPO_ATLAS_JSON_REFERENCE;
  if (fs.existsSync(path.join(runDir, ...LEGACY_CODEGRAPH_REPO_ATLAS_JSON_REFERENCE.split('/')))) return LEGACY_CODEGRAPH_REPO_ATLAS_JSON_REFERENCE;
  return undefined;
}

function fullArtifactReferencesForRun(runDir: string): string[] {
  const references = [...FULL_ARTIFACT_REFERENCES];
  const codeGraphRepoAtlas = codeGraphRepoAtlasArtifactReference(runDir);
  const codeGraphRepoAtlasJson = codeGraphRepoAtlasJsonArtifactReference(runDir);
  if (codeGraphRepoAtlas) references.push(codeGraphRepoAtlas);
  if (codeGraphRepoAtlasJson) references.push(codeGraphRepoAtlasJson);
  if (codeGraphContextArtifactExists(runDir)) {
    references.push(CODEGRAPH_CONTEXT_REFERENCE);
  }
  return references;
}

function selectRelevant(runDir: string, task: string, taskIntent?: TaskIntent): RelevanceSelection {
  const tokens = taskTokens(task);
  const normalizedTokens = (taskIntent?.enabled && taskIntent.ok)
    ? taskTokens(taskIntent.normalized_english_task)
    : [];
  const hintTokens = (taskIntent?.enabled && taskIntent.ok)
    ? taskIntent.search_hints.flatMap((hint) => taskTokens(hint))
    : [];
  const keywordGroupTokens = (taskIntent?.enabled && taskIntent.ok)
    ? Object.values(taskIntent.keyword_groups).flatMap((terms) => terms.flatMap((term) => taskTokens(term)))
    : [];
  const allTokens = unique([...tokens, ...normalizedTokens, ...hintTokens, ...keywordGroupTokens]);
  const inventoryPaths = collectInventoryPaths(runDir);
  const boosts = collectKeywordBoosts(runDir);
  const exactTextReasons = collectExactTextReasons(runDir);
  const hintBoosts = collectHintBoosts(taskIntent);
  const paths = unique([...inventoryPaths, ...Array.from(boosts.keys()), ...Array.from(exactTextReasons.keys())]);
  const scoredFiles = sortedTop(
    paths.map((filePath) => scorePath(filePath, allTokens, hintBoosts, boosts.get(filePath), exactTextReasons.get(filePath) ?? [])),
    40,
  );

  const testRecords = asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.tests), ['tests', 'test_files']);
  const testPaths = unique(testRecords.map(getPath).filter(Boolean).concat(paths.filter((p) => /(^|\/)tests?\//.test(p) || /\.test\./.test(p))));
  const selectedTests = sortedTop(testPaths.map((filePath) => scorePath(filePath, allTokens, hintBoosts, boosts.get(filePath), exactTextReasons.get(filePath) ?? [])), 15);

  const docRecords = [
    ...asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.repo_instructions), ['repo_instructions', 'instructions']),
    ...asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.docs), ['docs']),
    ...asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.architecture_docs), ['architecture_docs']),
  ];
  const selectedDocs = sortedTop(docRecords.map((record) => scorePath(getPath(record), allTokens, hintBoosts, 'doc/instruction reference')), 8);

  const selectedFileSet = new Set(scoredFiles.slice(0, 20).map((item) => item.path));
  const symbols = asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.symbols), ['symbols'])
    .filter((record) => selectedFileSet.has(getPath(record)))
    .slice(0, 180)
    .map((record) => ({
      path: getPath(record),
      name: getString(record, 'name'),
      signature: truncate(getString(record, 'signature'), 180),
      line: record.line,
    }));

  const imports = asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.imports), ['imports'])
    .filter((record) => selectedFileSet.has(getPath(record)) || selectedFileSet.has(getString(record, 'target')))
    .slice(0, 100)
    .map((record) => ({
      path: getPath(record),
      target: getString(record, 'target'),
      kind: getString(record, 'kind'),
      line: record.line,
    }));

  return {
    selected_files: scoredFiles,
    selected_tests: selectedTests,
    selected_docs: selectedDocs,
    selected_symbols: {
      count: symbols.length,
      reasons: ['selected only symbols from top relevant files', 'capped below 200 symbols'],
      symbols,
    },
    selected_import_edges: {
      count: imports.length,
      reasons: ['selected only import edges touching relevant files', 'capped at 100 edges'],
      edges: imports,
    },
    excluded_large_sections: ['full symbols dump', 'full imports dump', 'full file inventory', 'full docs', 'full architecture documents', 'all keyword hits'],
    full_artifacts_referenced: fullArtifactReferencesForRun(runDir),
  };
}

function keyFilesForSubsystem(paths: string[], prefixes: string[], limit = 8): string[] {
  return paths.filter((filePath) => prefixes.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`))).slice(0, limit);
}

function inferResponsibility(name: string): string {
  const map: Record<string, string> = {
    CLI: 'Human/agent command surface and JSON envelopes.',
    Desktop: 'Electron renderer/main/preload shell and desktop UX.',
    'Prompting Pipeline': 'Run orchestration, flash input, context pack, and final prompt rendering.',
    Config: 'Provider registry and local/global flash configuration without secrets.',
    'LLM Adapters': 'Mock and live flash provider calls plus diagnostics.',
    Scanner: 'Deterministic read-only repository scan artifacts.',
    Skills: 'Project skills catalog, copy, and selected skill expansion.',
    'Terminal/PTY': 'Real PTY-backed terminal sessions and embedded xterm UI.',
    Tests: 'Vitest and integration regression coverage.',
    Docs: 'Architecture, implementation contracts, and operational instructions.',
  };
  return map[name] ?? 'Repository subsystem.';
}

function headingText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.title === 'string') return record.title;
  if (typeof record.heading === 'string') return record.heading;
  if (typeof record.name === 'string') return record.name;
  return '';
}

function renderRepoAtlas(opts: BuildCompactFlashContextOptions, artifactReferences = fullArtifactReferencesForRun(opts.runDir)): string {
  const allPaths = collectInventoryPaths(opts.runDir);
  const topLevel = new Map<string, number>();
  for (const filePath of allPaths) {
    const top = filePath.split('/')[0] || filePath;
    topLevel.set(top, (topLevel.get(top) ?? 0) + 1);
  }
  const atlasParts: string[] = [];
  atlasParts.push('# Repo Atlas');
  atlasParts.push('');
  atlasParts.push('## Product Shape');
  atlasParts.push('- VibecodeLight is an Electron/TypeScript desktop + CLI workspace for reproducible AI-agent terminal runs.');
  atlasParts.push('- TypeScript owns orchestration, prompt/context artifacts, config, LLM adapters, desktop, and PTY integration.');
  atlasParts.push('- Python owns deterministic scanning only and writes scan artifacts under the per-run scan directory.');
  atlasParts.push('- Flash context should provide a map and task slice, not full scan databases.');
  atlasParts.push('');
  atlasParts.push('## Top-Level Directory Map');
  if (topLevel.size === 0) atlasParts.push('- not available');
  for (const [dir, count] of Array.from(topLevel.entries()).sort((a, b) => a[0].localeCompare(b[0])).slice(0, 40)) {
    atlasParts.push(`- ${dir}/ — ${count} files`);
  }
  atlasParts.push('');
  atlasParts.push('## Main Subsystems');
  for (const subsystem of SUBSYSTEMS) {
    const keyFiles = keyFilesForSubsystem(allPaths, subsystem.paths);
    const relatedTests = allPaths.filter((filePath) => filePath.startsWith('tests/') && subsystem.paths.some((prefix) => filePath.toLowerCase().includes(prefix.split('/').pop() ?? ''))).slice(0, 5);
    atlasParts.push(`### ${subsystem.name}`);
    atlasParts.push(`- Path: ${subsystem.paths.join(', ')}`);
    atlasParts.push(`- Responsibility: ${inferResponsibility(subsystem.name)}`);
    atlasParts.push(`- Key files: ${keyFiles.length ? keyFiles.join(', ') : 'not found in scan'}`);
    atlasParts.push(`- Related tests: ${relatedTests.length ? relatedTests.join(', ') : 'see tests/ for coverage'}`);
    atlasParts.push('- Notes: summary only; inspect full artifacts or source files for implementation details.');
  }
  atlasParts.push('');
  atlasParts.push('## Entry Points');
  const entrypoints = asRecords(readJson(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.entrypoints), ['entrypoints'])
    .map(getPath)
    .filter(Boolean)
    .slice(0, 20);
  const fallbackEntrypoints = ['src/app/cli/index.ts', 'src/core/prompting/pipeline.ts', 'src/app/desktop/main.ts', 'src/app/desktop/renderer/index.html'].filter((p) => allPaths.includes(p));
  for (const entry of (entrypoints.length ? entrypoints : fallbackEntrypoints)) atlasParts.push(`- ${entry}`);
  if (entrypoints.length === 0 && fallbackEntrypoints.length === 0) atlasParts.push('- not available');
  atlasParts.push('');
  atlasParts.push('## Generated / Runtime Areas');
  atlasParts.push('- .vibecode/ — generated run, current, index, flash, and scan artifacts; do not commit.');
  atlasParts.push('- node_modules/, dist/, coverage/, .venv/, __pycache__/ — generated/ignored dependency and build areas.');
  atlasParts.push('');
  atlasParts.push('## Full Artifact References');
  for (const ref of artifactReferences) atlasParts.push(`- ${ref}`);
  const codeGraphRepoAtlas = renderCodeGraphRepoAtlas(opts.runDir);
  if (codeGraphRepoAtlas) {
    atlasParts.push('', '## CodeGraph-Derived Repo Atlas', codeGraphRepoAtlas);
  }
  return capMarkdown(redactSecrets(atlasParts.join('\n')), REPO_ATLAS_HARD_MAX_TOKENS, 'Repo Atlas');
}

function docExcerpt(runDir: string, docPath: string): string {
  const sources = [
    ...asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.repo_instructions), ['repo_instructions', 'instructions']),
    ...asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.docs), ['docs']),
    ...asRecords(readJson(runDir, FLASH_INPUT_OPTIONAL_INPUTS.architecture_docs), ['architecture_docs']),
  ];
  const doc = sources.find((record) => getPath(record) === docPath);
  if (!doc) return '';
  const headings = Array.isArray(doc.headings)
    ? doc.headings
      .slice(0, 8)
      .map((heading) => headingText(heading))
      .filter(Boolean)
      .join(', ')
    : '';
  const excerpt = truncate(getString(doc, 'excerpt') || getString(doc, 'summary') || getString(doc, 'content'), 1000);
  return [headings ? `headings: ${headings}` : '', excerpt].filter(Boolean).join(' — ');
}

function renderTaskSlice(opts: BuildCompactFlashContextOptions, selection: RelevanceSelection): string {
  const parts: string[] = [];
  parts.push('# Task Slice');
  parts.push('');
  parts.push('## User Task');
  parts.push(truncate(opts.task, 4000));
  parts.push('');
  parts.push('## Previous Run Summary');
  parts.push(opts.previousRunSummary ? truncate(opts.previousRunSummary, 2000) : 'none available');
  parts.push('');
  parts.push('## Task Intent');
  if (opts.taskIntent?.enabled && opts.taskIntent.ok) {
    const intent = opts.taskIntent;
    parts.push('Task Normalizer: on');
    parts.push(`Original task language: ${intent.original_language}`);
    parts.push('');
    parts.push('Normalized English task:');
    parts.push(intent.normalized_english_task);
    if (intent.search_hints.length > 0) {
      parts.push('');
      parts.push('Search hints:');
      for (const hint of intent.search_hints) parts.push(`- ${hint}`);
    }
    if (intent.negative_constraints.length > 0) {
      parts.push('');
      parts.push('Constraints:');
      for (const constraint of intent.negative_constraints) parts.push(`- ${constraint}`);
    }
    if (intent.validation_hints.length > 0) {
      parts.push('');
      parts.push('Validation hints:');
      for (const hint of intent.validation_hints) parts.push(`- ${hint}`);
    }
    if (intent.warnings.length > 0) {
      parts.push('');
      parts.push('Warnings:');
      for (const warning of intent.warnings) parts.push(`- ${warning}`);
    }
  } else if (opts.taskIntent?.enabled && !opts.taskIntent.ok) {
    parts.push('Task Normalizer: fallback (failed)');
    if (opts.taskIntent.warnings.length > 0) {
      for (const warning of opts.taskIntent.warnings) parts.push(`- ${warning}`);
    }
    parts.push('Using raw user task only.');
  } else {
    parts.push('Task Normalizer: off');
    parts.push('Using raw user task only.');
  }
  parts.push('');
  parts.push('## Ranked Relevant Files');
  for (const item of selection.selected_files.slice(0, 25)) {
    parts.push(`- ${item.path} — selected by: ${item.reasons.join('; ') || 'repository map'}`);
  }
  if (selection.selected_files.length === 0) parts.push('- not available');
  parts.push('');
  parts.push('## Ranked Relevant Tests');
  for (const item of selection.selected_tests.slice(0, 15)) {
    parts.push(`- ${item.path} — selected by: ${item.reasons.join('; ') || 'test candidate'}`);
  }
  if (selection.selected_tests.length === 0) parts.push('- not available');
  parts.push('');
  parts.push('## Ranked Relevant Docs / Instructions');
  for (const item of selection.selected_docs.slice(0, 8)) {
    parts.push(`- ${item.path} — ${docExcerpt(opts.runDir, item.path)}`);
  }
  if (selection.selected_docs.length === 0) parts.push('- not available');
  parts.push('');
  parts.push('## Selected Symbols (Relevant Files Only)');
  for (const symbol of selection.selected_symbols.symbols.slice(0, 180)) {
    parts.push(`- ${String(symbol.path)} :: ${String(symbol.name)} — ${String(symbol.signature ?? '')}`);
  }
  if (selection.selected_symbols.count === 0) parts.push('- none selected');
  parts.push('');
  parts.push('## Selected Import / Dependency Edges (Relevant Files Only)');
  for (const edge of selection.selected_import_edges.edges.slice(0, 100)) {
    parts.push(`- ${String(edge.path)} -> ${String(edge.target)} (${String(edge.kind ?? 'unknown')})`);
  }
  if (selection.selected_import_edges.count === 0) parts.push('- none selected');
  parts.push('');
  parts.push('## Relevant Cautions');
  parts.push('- Do not change flash provider registry shape, mock/live semantics, prompt output contract, or scanner ownership.');
  parts.push('- Do not embed full scan JSON dumps in flash input; reference full artifacts on disk instead.');
  parts.push('- Do not expose API keys, tokens, secrets, or environment values in generated context artifacts.');
  parts.push('');
  parts.push('## Validation Commands');
  for (const command of VALIDATION_COMMANDS) parts.push(`- ${command}`);
  return capMarkdown(redactSecrets(parts.join('\n')), TASK_SLICE_HARD_MAX_TOKENS, 'Task Slice');
}

function capMarkdown(markdown: string, hardMaxTokens: number, label: string): string {
  const maxChars = hardMaxTokens * 4;
  if (markdown.length <= maxChars) return markdown;
  return `${markdown.slice(0, maxChars - 80).trimEnd()}\n\n_Trimmed: ${label} exceeded ${hardMaxTokens} estimated tokens._\n`;
}

function renderArtifactReferences(artifactReferences: string[]): string {
  return [
    'The following full artifacts exist on disk for tools/manual inspection. They are referenced, not embedded, to preserve context budget:',
    '',
    ...artifactReferences.map((ref) => `- ${ref}`),
  ].join('\n');
}

function renderFlashInstructions(): string {
  return [
    'Return Markdown using the existing flash_output.md contract exactly:',
    '- # Task Summary',
    '- # Relevant Files',
    '- # Files To Read With Tools',
    '- # Relevant Tests',
    '- # Commands To Run',
    '- # Selected Skills',
    '- # Cautions',
    '- # Context Pack',
    '',
    'Use the Repo Atlas for whole-repo orientation and the Task Slice for task-specific relevance.',
    'Do not ask for or reveal secrets. Do not invent facts missing from the scan artifacts.',
  ].join('\n');
}

function getVibecodePath(runDir: string): string | undefined {
  const runsDir = path.dirname(runDir);
  const vibecodePath = path.dirname(runsDir);
  if (path.basename(runsDir) === 'runs' && path.basename(vibecodePath) === '.vibecode') return vibecodePath;
  return undefined;
}

function compactPaths(runDir: string): CompactFlashArtifactPaths {
  const flashDir = path.join(runDir, 'flash');
  const vibecodePath = getVibecodePath(runDir);
  return {
    ...(vibecodePath ? { repo_atlas_path: path.join(vibecodePath, 'index', 'repo_atlas.generated.md') } : {}),
    run_repo_atlas_path: path.join(flashDir, 'repo_atlas.md'),
    task_slice_path: path.join(flashDir, 'task_slice.md'),
    relevance_selection_path: path.join(flashDir, 'relevance_selection.json'),
    flash_input_budget_path: path.join(flashDir, 'flash_input_budget.json'),
  };
}

function renderCodeGraphRepoAtlas(runDir: string): string | undefined {
  const usage = readJson(runDir, 'scan/codegraph_usage.json');
  if (typeof usage !== 'object' || usage === null) return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const generated = usageRecord.codegraph_repo_atlas_generated === true || usageRecord.repo_atlas_generated === true;
  if (usageRecord.used !== true || !generated) return undefined;
  const artifact = typeof usageRecord.codegraph_repo_atlas_artifact === 'string'
    ? usageRecord.codegraph_repo_atlas_artifact
    : (typeof usageRecord.repo_atlas_artifact === 'string' ? usageRecord.repo_atlas_artifact : CODEGRAPH_REPO_ATLAS_REFERENCE);
  const atlas = readText(runDir, artifact);
  if (!atlas.trim()) return undefined;
  const jsonArtifact = typeof usageRecord.codegraph_repo_atlas_json_artifact === 'string'
    ? usageRecord.codegraph_repo_atlas_json_artifact
    : (typeof usageRecord.repo_atlas_json_artifact === 'string' ? usageRecord.repo_atlas_json_artifact : undefined);
  return [
    `Artifact: ${artifact}`,
    jsonArtifact ? `JSON: ${jsonArtifact}` : '',
    '',
    atlas.replace(/^# Repo Atlas\n?/, '').trim(),
  ].filter(Boolean).join('\n');
}

function renderCodeGraphContext(runDir: string): string | undefined {
  const usage = readJson(runDir, 'scan/codegraph_usage.json');
  if (typeof usage !== 'object' || usage === null) return undefined;
  const usageRecord = usage as Record<string, unknown>;
  if (usageRecord.used !== true) return undefined;
  const artifact = typeof usageRecord.artifact === 'string' ? usageRecord.artifact : 'scan/codegraph_context.md';
  const hasRepoAtlas = (usageRecord.codegraph_repo_atlas_generated === true || usageRecord.repo_atlas_generated === true)
    && readText(
      runDir,
      typeof usageRecord.codegraph_repo_atlas_artifact === 'string'
        ? usageRecord.codegraph_repo_atlas_artifact
        : (typeof usageRecord.repo_atlas_artifact === 'string' ? usageRecord.repo_atlas_artifact : CODEGRAPH_REPO_ATLAS_REFERENCE),
    ).trim().length > 0;
  const context = readText(runDir, artifact);
  if (!context.trim()) return undefined;
  if (hasRepoAtlas) {
    return [
      'Source: existing local CodeGraph index',
      `Mode: ${typeof usageRecord.mode === 'string' ? usageRecord.mode : 'use-existing'}`,
      `Artifact: ${artifact}`,
      '',
      'Full CodeGraph context remains available at scan/codegraph_context.md. It is referenced, not embedded, because Repo Atlas already includes bounded CodeGraph-derived hints.',
      'CodeGraph output is guidance, not source of truth. Main model must still inspect exact files before editing.',
    ].join('\n');
  }
  return [
    'Source: existing local CodeGraph index',
    `Mode: ${typeof usageRecord.mode === 'string' ? usageRecord.mode : 'use-existing'}`,
    `Artifact: ${artifact}`,
    '',
    'CodeGraph output is guidance, not source of truth. Main model must still inspect exact files before editing.',
    '',
    truncate(context, 12_000),
  ].join('\n');
}

function buildBudget(
  sections: Array<{ title: string; body: string }>,
  providerCalled: boolean,
  budgetStatus: FlashInputBudget['budget_status'],
  artifactReferences: string[],
): FlashInputBudget {
  const rendered = renderSections(sections);
  return {
    target_tokens: FLASH_INPUT_TARGET_TOKENS,
    hard_max_tokens: FLASH_INPUT_HARD_MAX_TOKENS,
    estimated_tokens: estimateTokens(rendered),
    estimated_chars: rendered.length,
    section_breakdown: sections.map((section) => ({
      title: section.title,
      estimated_tokens: estimateTokens(section.body),
      estimated_chars: section.body.length,
    })),
    included_sections: sections.map((section) => section.title),
    summarized_sections: ['Repo Atlas', 'Task Slice', 'Symbols', 'Imports', 'File Inventory', 'Docs', 'Tests', 'Keyword Hits', 'Recent History'],
    excluded_sections: ['full Symbols dump', 'full Imports dump', 'full File Inventory dump', 'full Architecture Documents dump', 'full Docs dump', 'all Keyword Hits'],
    full_artifacts_referenced: artifactReferences,
    provider_called: providerCalled,
    budget_status: budgetStatus,
  };
}

function renderSections(sections: Array<{ title: string; body: string }>): string {
  return `${sections.map((section) => `# ${section.title}\n${section.body.trim()}`).join('\n\n')}\n`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

export function buildCompactFlashContext(opts: BuildCompactFlashContextOptions): CompactFlashArtifacts {
  const paths = compactPaths(opts.runDir);
  const artifactReferences = fullArtifactReferencesForRun(opts.runDir);
  const repoAtlas = renderRepoAtlas(opts, artifactReferences);
  const relevanceSelection = selectRelevant(opts.runDir, opts.task, opts.taskIntent);
  const taskSlice = renderTaskSlice(opts, relevanceSelection);
  const codeGraphContext = renderCodeGraphContext(opts.runDir);
  const sections = [
    { title: 'Task', body: `\`\`\`text\n${truncate(readText(opts.runDir, 'user_prompt.md') || opts.task, 4000)}\n\`\`\`` },
    { title: 'Repo Atlas', body: repoAtlas.replace(/^# Repo Atlas\n?/, '').trim() },
    { title: 'Task Slice', body: taskSlice.replace(/^# Task Slice\n?/, '').trim() },
    ...(codeGraphContext ? [{ title: 'CodeGraph Context', body: codeGraphContext }] : []),
    { title: 'Available Full Artifacts', body: renderArtifactReferences(artifactReferences) },
    { title: 'Flash Instructions', body: renderFlashInstructions() },
  ];
  const flashInput = renderSections(sections);
  const budgetStatus = estimateTokens(flashInput) > FLASH_INPUT_HARD_MAX_TOKENS ? 'FLASH_INPUT_BUDGET_EXCEEDED' : 'ok';
  const budget = buildBudget(sections, false, budgetStatus, artifactReferences);

  writeText(paths.run_repo_atlas_path, `${repoAtlas}\n`);
  if (paths.repo_atlas_path) writeText(paths.repo_atlas_path, `${repoAtlas}\n`);
  writeText(paths.task_slice_path, `${taskSlice}\n`);
  writeJson(paths.relevance_selection_path, relevanceSelection);
  writeJson(paths.flash_input_budget_path, budget);

  if (budgetStatus !== 'ok') {
    throw new FlashInputBudgetError(
      `flash_input.md estimated ${budget.estimated_tokens} tokens exceeds hard max ${FLASH_INPUT_HARD_MAX_TOKENS}`,
      paths.flash_input_budget_path,
      [`estimated_tokens=${budget.estimated_tokens}`, `hard_max_tokens=${FLASH_INPUT_HARD_MAX_TOKENS}`],
    );
  }

  return { flashInput, repoAtlas, taskSlice, relevanceSelection, budget, paths };
}

export function markFlashInputProviderCalled(runDir: string, providerCalled: boolean): void {
  const budgetPath = compactPaths(runDir).flash_input_budget_path;
  if (!fs.existsSync(budgetPath)) return;
  const raw = fs.readFileSync(budgetPath, 'utf8');
  try {
    const budget = JSON.parse(raw) as FlashInputBudget;
    budget.provider_called = providerCalled;
    writeJson(budgetPath, budget);
  } catch {
    // Best-effort diagnostics update only.
  }
}

export function readFlashInputBudget(runDir: string): FlashInputBudget | undefined {
  const budgetPath = compactPaths(runDir).flash_input_budget_path;
  if (!fs.existsSync(budgetPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(budgetPath, 'utf8')) as FlashInputBudget;
  } catch {
    return undefined;
  }
}
