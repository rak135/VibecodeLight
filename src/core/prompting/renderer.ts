import fs from 'fs';
import path from 'path';

import type { FlashOutputMeta } from '../context/flash_output_meta.js';
import type { RunManifest } from '../models/index.js';
import {
  readSelectedSkillsManifest,
  type SelectedSkillsManifest,
} from '../skills/selected_manifest.js';
import { readAgentBinding } from '../coordination/agent_binding.js';
import {
  buildCoordinationPromptContext,
  type CoordinationPromptContext,
} from '../coordination/prompt_context.js';
import { renderCoordinationSection } from './coordination_section.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptRenderError {
  code: string;
  message: string;
  path?: string;
  details: string[];
}

export interface PromptRenderResult {
  ok: boolean;
  runId?: string;
  artifacts?: string[];
  warnings?: string[];
  error?: PromptRenderError;
}

export interface RenderOptions {
  /** .vibecode/ directory path; when provided, current/ mirror is updated. */
  vibecodePath?: string;
  /**
   * Repo root. When provided (and `coordination` is not given explicitly), the
   * renderer self-resolves the coordination block from the run's
   * `coordination/agent_binding.json` plus live coordination state.
   */
  repoRoot?: string;
  /**
   * Explicit coordination prompt context. When provided (including `null`), it
   * overrides self-resolution. `null` deterministically omits the block. Unit
   * tests pass this directly to stay decoupled from coordination state on disk.
   */
  coordination?: CoordinationPromptContext | null;
  /** Clock override for deterministic stale computation during self-resolution. */
  now?: string;
}

// ---------------------------------------------------------------------------
// Artifact readers
// ---------------------------------------------------------------------------

function readRequired(filePath: string, code: string): string {
  if (!fs.existsSync(filePath)) {
    const err: PromptRenderError = {
      code,
      message: `missing required artifact: ${filePath}`,
      path: filePath,
      details: [`Expected file at: ${filePath}`],
    };
    throw err;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function readOptionalMeta(metaPath: string): FlashOutputMeta | null {
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as FlashOutputMeta;
  } catch {
    return null;
  }
}

function readOptionalJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listItems(items: string[]): string {
  if (items.length === 0) return '_None_\n';
  return items.map((item) => `- ${item}`).join('\n') + '\n';
}

function uniqueItems(items: string[]): string[] {
  return Array.from(new Set(items));
}

// ---------------------------------------------------------------------------
// File-list sanitization (strip flash formatting noise before rendering)
// ---------------------------------------------------------------------------

// Trailing parenthetical annotations that signal flash speculation rather than
// a concrete file reference. Matched at end of string.
const SPECULATION_PATTERN =
  /\s*\((?:or\s+similar[^)]*|if\s+(?:exists?|present|any|available)|possibly[^)]*|maybe[^)]*|likely[^)]*)\)\s*$/i;

export interface SanitizedFileEntry {
  /** Cleaned repo-relative path, or null if the entry was not a concrete path. */
  path: string | null;
  /** True when a speculation annotation was stripped from this entry. */
  tainted: boolean;
}

export function sanitizeFileEntry(raw: unknown): SanitizedFileEntry {
  if (typeof raw !== 'string') return { path: null, tainted: false };
  let s = raw.trim();
  let tainted = false;
  // Strip one or more trailing speculation annotations.
  while (SPECULATION_PATTERN.test(s)) {
    s = s.replace(SPECULATION_PATTERN, '').trim();
    tainted = true;
  }
  // Strip wrapping backticks (single or triple).
  while (s.startsWith('`')) s = s.slice(1);
  while (s.endsWith('`')) s = s.slice(0, -1);
  s = s.trim();
  if (!s) return { path: null, tainted };
  // A concrete repo-relative path has no internal whitespace.
  if (/\s/.test(s)) return { path: null, tainted };
  // Must look like a path: contain a slash or have a file extension.
  if (!s.includes('/') && !/\.[A-Za-z0-9]+$/.test(s)) return { path: null, tainted };
  return { path: s, tainted };
}

/**
 * Compute the set of paths that appeared with a speculation annotation in any
 * of the given lists. A tainted path requires canonical evidence to survive
 * filtering, even if a different list referenced it cleanly.
 */
function collectTaintedPaths(lists: Array<unknown[] | undefined>): Set<string> {
  const tainted = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const r = sanitizeFileEntry(raw);
      if (r.tainted && r.path) tainted.add(r.path);
    }
  }
  return tainted;
}

/**
 * Sanitize a file list, applying taint-based filtering.
 *
 * - Strips backticks and speculation annotations on every entry.
 * - Drops entries that aren't concrete paths.
 * - Drops tainted paths unless `canonical` is non-empty and contains them.
 *   When `canonical` is empty (e.g., a unit test without scanner artifacts),
 *   tainted paths are kept so callers don't have to fabricate evidence.
 */
function sanitizeFileList(
  entries: unknown[] | undefined,
  taintedPaths: Set<string>,
  canonical: Set<string>,
): string[] {
  if (!Array.isArray(entries)) return [];
  const haveCanonical = canonical.size > 0;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const { path: p } = sanitizeFileEntry(raw);
    if (!p) continue;
    if (haveCanonical && taintedPaths.has(p) && !canonical.has(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outer markdown fence unwrap for context pack body
// ---------------------------------------------------------------------------

/**
 * If `content`'s entire body is wrapped in a single outer ```...``` fence
 * (optionally tagged ```markdown / ```md / ```text), strip that outer fence.
 * Internal fenced code blocks are preserved — we only unwrap when the outer
 * fence pairs with a closer at the end and any internal fences are balanced.
 */
export function unwrapOuterMarkdownFence(content: string): string {
  if (!content) return content;
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);

  let firstIdx = 0;
  while (firstIdx < lines.length && lines[firstIdx].trim() === '') firstIdx++;
  if (firstIdx >= lines.length) return content;

  // Opening fence: ``` or ```lang (lang is a single word like markdown/md/text).
  if (!/^```[A-Za-z0-9_-]*\s*$/.test(lines[firstIdx])) return content;

  let lastIdx = lines.length - 1;
  while (lastIdx > firstIdx && lines[lastIdx].trim() === '') lastIdx--;
  if (lastIdx <= firstIdx) return content;

  if (!/^```\s*$/.test(lines[lastIdx])) return content;

  // Ensure internal fences (if any) are balanced — otherwise we'd be
  // unwrapping a fence that belongs to inner code.
  let internalFenceCount = 0;
  for (let i = firstIdx + 1; i < lastIdx; i++) {
    if (/^```/.test(lines[i].trim())) internalFenceCount++;
  }
  if (internalFenceCount % 2 !== 0) return content;

  const leading = lines.slice(0, firstIdx);
  const inner = lines.slice(firstIdx + 1, lastIdx);
  const trailing = lines.slice(lastIdx + 1);
  return [...leading, ...inner, ...trailing].join('\n');
}

// ---------------------------------------------------------------------------
// Task Normalizer diagnostic section stripping
// ---------------------------------------------------------------------------

/**
 * Headings produced by the Task Normalizer diagnostic flow that occasionally
 * leak into the flash-authored Context Pack body. They duplicate signal that
 * is already represented authoritatively elsewhere in final_prompt.md
 * (Task Summary, Cautions, Exact Text Matches, Relevant Files) and are
 * therefore stripped before rendering.
 *
 * task_intent.json itself is left untouched on disk; this only filters what
 * the implementation agent sees in final_prompt.md.
 */
const TASK_NORMALIZER_DIAGNOSTIC_HEADINGS = new Set([
  'Task Intent',
  'Search Hints',
  'Constraints',
]);

export function stripTaskNormalizerDiagnostics(content: string): string {
  if (!content) return content;
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      const name = h2[1].trim();
      if (TASK_NORMALIZER_DIAGNOSTIC_HEADINGS.has(name)) {
        skipping = true;
        continue;
      }
      skipping = false;
    } else if (/^#\s+/.test(line)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// File-kind classifier (used only for final prompt rendering priority)
// ---------------------------------------------------------------------------

export type FileKind = 'implementation' | 'test' | 'docs' | 'generated' | 'unknown';

export function classifyPath(p: string): FileKind {
  const lower = p.replace(/\\/g, '/').toLowerCase();
  if (
    lower.startsWith('node_modules/') ||
    lower.includes('/node_modules/') ||
    lower.startsWith('dist/') ||
    lower.startsWith('build/') ||
    lower.startsWith('coverage/') ||
    lower.startsWith('.next/') ||
    lower.includes('.generated.') ||
    lower.endsWith('.min.js')
  ) {
    return 'generated';
  }
  if (
    lower.startsWith('tests/') ||
    lower.includes('/tests/') ||
    lower.startsWith('test/') ||
    lower.includes('/test/') ||
    /\.(test|spec)\.[a-z0-9]+$/.test(lower)
  ) {
    return 'test';
  }
  if (lower.startsWith('docs/') || lower.endsWith('.md')) {
    return 'docs';
  }
  if (
    lower.startsWith('src/') ||
    lower.startsWith('app/') ||
    lower.startsWith('packages/') ||
    lower.startsWith('lib/')
  ) {
    return 'implementation';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Exact text evidence collection / filtering
// ---------------------------------------------------------------------------

interface RelevanceSelectionArtifact {
  selected_files?: Array<{ path?: unknown; reasons?: unknown }>;
}

interface ExactTextHitsArtifact {
  exact_text_hits?: Array<{
    path?: unknown;
    term?: unknown;
    match_type?: unknown;
    line?: unknown;
  }>;
}

interface ExactGroup {
  path: string;
  lines: number[];
  terms: string[];
  selectedByExact: boolean;
  kind: FileKind;
}

function collectExactTextGroups(
  hits: ExactTextHitsArtifact | null,
  selection: RelevanceSelectionArtifact | null,
): ExactGroup[] {
  const byPath = new Map<
    string,
    { lineSet: Set<number>; terms: Set<string>; selected: boolean }
  >();

  const ensureEntry = (key: string) => {
    let entry = byPath.get(key);
    if (!entry) {
      entry = { lineSet: new Set<number>(), terms: new Set<string>(), selected: false };
      byPath.set(key, entry);
    }
    return entry;
  };

  if (Array.isArray(hits?.exact_text_hits)) {
    for (const item of hits.exact_text_hits) {
      if (typeof item.path !== 'string' || item.path.length === 0) continue;
      if (typeof item.term !== 'string' || item.term.length === 0) continue;
      const entry = ensureEntry(item.path);
      if (typeof item.line === 'number' && Number.isFinite(item.line)) {
        entry.lineSet.add(item.line);
      }
      entry.terms.add(item.term);
    }
  }

  if (Array.isArray(selection?.selected_files)) {
    for (const item of selection.selected_files) {
      if (typeof item.path !== 'string' || item.path.length === 0) continue;
      const reasons = Array.isArray(item.reasons)
        ? item.reasons.filter((reason): reason is string => typeof reason === 'string')
        : [];
      const exactReasons = reasons.filter((reason) =>
        reason.toLowerCase().includes('exact text match'),
      );
      if (exactReasons.length === 0) continue;
      const entry = ensureEntry(item.path);
      entry.selected = true;
      for (const reason of exactReasons) {
        const m = reason.match(/exact text match:\s*"([^"]+)"/i);
        if (m) entry.terms.add(m[1]);
      }
    }
  }

  const groups: ExactGroup[] = [];
  for (const [key, entry] of byPath.entries()) {
    groups.push({
      path: key,
      lines: [...entry.lineSet].sort((a, b) => a - b),
      terms: [...entry.terms],
      selectedByExact: entry.selected,
      kind: classifyPath(key),
    });
  }
  return groups;
}

const MAX_PRIMARY_FILES = 3;
const MAX_RELATED_TESTS = 2;
const MAX_LINES_PER_FILE = 2;

interface FilteredExactGroups {
  kept: ExactGroup[];
  omittedCount: number;
}

function filterExactTextGroups(
  groups: ExactGroup[],
  relevantSignals: Set<string>,
): FilteredExactGroups {
  const impl: ExactGroup[] = [];
  const tests: ExactGroup[] = [];
  const docs: ExactGroup[] = [];
  const unknowns: ExactGroup[] = [];
  for (const g of groups) {
    if (g.kind === 'implementation') impl.push(g);
    else if (g.kind === 'test') tests.push(g);
    else if (g.kind === 'docs') docs.push(g);
    else if (g.kind === 'unknown') unknowns.push(g);
    // generated: dropped silently
  }

  // Stable order: keep input order within each bucket.
  const keptImpl = impl.slice(0, MAX_PRIMARY_FILES);

  let keptTests: ExactGroup[];
  if (keptImpl.length > 0) {
    keptTests = tests
      .filter((g) => relevantSignals.has(g.path))
      .slice(0, MAX_RELATED_TESTS);
  } else {
    // No implementation hits — surface up to MAX_RELATED_TESTS tests so the
    // signal is still visible. Prefer those flagged as relevant first.
    const relevantFirst = [
      ...tests.filter((g) => relevantSignals.has(g.path)),
      ...tests.filter((g) => !relevantSignals.has(g.path)),
    ];
    keptTests = relevantFirst.slice(0, MAX_RELATED_TESTS);
  }

  // Docs only when no impl/test signal exists — usually irrelevant.
  let keptDocs: ExactGroup[] = [];
  if (keptImpl.length === 0 && keptTests.length === 0) {
    keptDocs = docs.slice(0, MAX_PRIMARY_FILES);
  }

  const kept = [...keptImpl, ...keptTests, ...keptDocs];
  const considered = impl.length + tests.length + docs.length + unknowns.length;
  const omittedCount = considered - kept.length;
  return { kept, omittedCount };
}

function renderExactGroupLine(g: ExactGroup): string {
  const linesDisplay = g.lines.slice(0, MAX_LINES_PER_FILE);
  let location = '';
  if (linesDisplay.length === 1) location = ` (line ${linesDisplay[0]})`;
  else if (linesDisplay.length > 1) location = ` (lines ${linesDisplay.join(', ')})`;
  // Prefer the longest term — usually the full sentence over an excerpt.
  const term = g.terms.length > 0
    ? g.terms.slice().sort((a, b) => b.length - a.length)[0]
    : '';
  const termPart = term ? ` — exact text match: "${term}"` : ' — exact text match';
  return `${g.path}${location}${termPart}`;
}

// ---------------------------------------------------------------------------
// Template builder
// ---------------------------------------------------------------------------

interface BuildFinalPromptOptions {
  task: string;
  manifest: RunManifest;
  contextPack: string;
  flashMeta: FlashOutputMeta | null;
  scanCommands: string[];
  repoInstructionFiles: string[];
  exactGroups: ExactGroup[];
  exactOmittedCount: number;
  sanitizedRelevantFiles: string[];
  sanitizedFilesToInspect: string[];
  rendererWarnings: string[];
  /** True when scan/external_tools.json reports CodeGraph available AND initialized. */
  codegraphReady: boolean;
  /**
   * UI-selected skills manifest. When present (and contains selected_skills),
   * the renderer emits a short Selected Skills section that names the skills
   * and tells the agent how to load them on demand. Full skill bodies are not
   * embedded in final_prompt.md. This manifest is the only source of the
   * Selected Skills section; flash output is never consulted.
   */
  selectedSkillsManifest: SelectedSkillsManifest | null;
  /**
   * Pre-rendered "# Multi-Agent Coordination" section. Empty string when no
   * agent is bound / coordination is inactive, in which case no block is added.
   */
  coordinationSection: string;
}

function renderSelectedSkillsManifestSection(manifest: SelectedSkillsManifest): string {
  const lines: string[] = [
    '# Selected Skills',
    '',
    'Full skill texts are not embedded in this prompt. Load selected skills only when needed.',
    '',
  ];
  for (const skill of manifest.selected_skills) {
    lines.push(`- ${skill.id}`);
    if (skill.summary && skill.summary.trim().length > 0) {
      lines.push(`  ${skill.summary.trim()}`);
    } else if (skill.title && skill.title.trim().length > 0 && skill.title.trim() !== skill.id) {
      lines.push(`  ${skill.title.trim()}`);
    }
    lines.push(`  Load:`);
    lines.push(`    vibecode skills show ${skill.id} --run-id ${manifest.run_id}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Conditional agent-tool advertisement. Shown only when CodeGraph appears
 * available and initialized for this run, so we never tell the implementation
 * agent to use a tool that does not exist. Kept intentionally short: 6
 * verified read-only subcommands plus a one-line rg/grep vs CodeGraph
 * guideline. No transport/MCP/agent-specific details.
 */
function renderAvailableRepoNavigationCommandsSection(runId: string): string {
  const suffix = ` --run-id ${runId}`;
  return (
    `# Available Repo Navigation Commands\n\n` +
    `Use these shell commands for structural repository navigation when useful:\n\n` +
    `- vibecode codegraph context "<query>"${suffix}\n` +
    `- vibecode codegraph search "<query>"${suffix}\n` +
    `- vibecode codegraph files${suffix}\n` +
    `- vibecode codegraph callers "<symbol>"${suffix}\n` +
    `- vibecode codegraph callees "<symbol>"${suffix}\n` +
    `- vibecode codegraph impact "<symbol>"${suffix}\n\n` +
    `Effective usage:\n\n` +
    `- Prefer context first for subsystem mapping and architecture orientation.\n` +
    `- Use search for broad discovery; expect possible low-signal results for keyword-style queries.\n` +
    `- Use callers / callees only after you have an exact indexed symbol name.\n` +
    `- Use impact for indexed symbols; do not assume file paths are supported.\n` +
    `- Use rg/grep for exact strings, error messages, UI labels, and literal text.\n` +
    `- After CodeGraph gives you a map, verify exact implementation details by reading source files and relevant tests.\n\n` +
    `Do not overuse CodeGraph. Prefer the smallest command that answers the question.\n`
  );
}

function buildFinalPrompt(opts: BuildFinalPromptOptions): string {
  const {
    task,
    manifest,
    contextPack,
    flashMeta,
    scanCommands,
    repoInstructionFiles,
    exactGroups,
    exactOmittedCount,
    sanitizedRelevantFiles,
    sanitizedFilesToInspect,
    rendererWarnings,
    codegraphReady,
  } = opts;

  const exactPaths = exactGroups.map((g) => g.path);
  const exactTextLines = exactGroups.map(renderExactGroupLine);

  const relevantFiles = uniqueItems([...exactPaths, ...sanitizedRelevantFiles]);
  const filesToInspect = uniqueItems([...exactPaths, ...sanitizedFilesToInspect]);
  const cautions = flashMeta?.cautions ?? [];
  const taskSummary = flashMeta?.task_summary?.trim() ?? '';
  const constraints = flashMeta?.constraints ?? [];
  const validationHints = flashMeta?.validation_hints ?? [];

  const commands = flashMeta?.commands_to_run?.length
    ? flashMeta.commands_to_run
    : scanCommands;

  // The UI-driven manifest is the ONLY source of the Selected Skills section.
  // Flash output's # Selected Skills section is never consulted, and the
  // legacy `selected_skill_contents.md` body is never rendered. When no skills
  // are selected, the section is omitted entirely — no "no selected skills"
  // placeholder, no empty header.
  let skillsSectionContent = '';
  let omitSkillsSection = true;
  if (opts.selectedSkillsManifest && opts.selectedSkillsManifest.selected_skills.length > 0) {
    skillsSectionContent = renderSelectedSkillsManifestSection(opts.selectedSkillsManifest).trim();
    omitSkillsSection = false;
  }

  const instructionSection =
    repoInstructionFiles.length > 0
      ? listItems(repoInstructionFiles)
      : '_No repository instruction files detected._\n';

  const contextPackBlocks: string[] = [];
  if (rendererWarnings.length > 0) {
    contextPackBlocks.push(
      `## Renderer Warnings\n${listItems(rendererWarnings).trimEnd()}`,
    );
  }
  if (taskSummary) {
    contextPackBlocks.push(`## Task Summary\n${taskSummary}`);
  }
  if (constraints.length > 0) {
    contextPackBlocks.push(`## Constraints\n${listItems(constraints).trimEnd()}`);
  }
  if (validationHints.length > 0) {
    contextPackBlocks.push(
      `## Validation Hints\n${listItems(validationHints).trimEnd()}`,
    );
  }
  if (exactTextLines.length > 0) {
    const body = listItems(exactTextLines).trimEnd();
    const tail =
      exactOmittedCount > 0
        ? '\n\nAdditional exact matches omitted; see scan/exact_text_hits.json.'
        : '';
    contextPackBlocks.push(`## Exact Text Matches\n${body}${tail}`);
  }
  if (relevantFiles.length > 0) {
    contextPackBlocks.push(`## Relevant Files\n${listItems(relevantFiles).trimEnd()}`);
  }
  if (filesToInspect.length > 0) {
    contextPackBlocks.push(
      `## Files To Inspect\n${listItems(filesToInspect).trimEnd()}`,
    );
  }
  if (commands.length > 0) {
    contextPackBlocks.push(`## Suggested Commands\n${listItems(commands).trimEnd()}`);
  }
  if (cautions.length > 0) {
    contextPackBlocks.push(`## Cautions\n${listItems(cautions).trimEnd()}`);
  }
  if (contextPack.trim().length > 0) {
    const cleaned = stripTaskNormalizerDiagnostics(unwrapOuterMarkdownFence(contextPack)).trim();
    if (cleaned.length > 0) {
      contextPackBlocks.push(cleaned);
    }
  }

  const sections: string[] = [
    `# Task\n\n${task.trim()}\n`,

    `# Repository Context\n\nRun ID: \`${manifest.run_id}\`\nCreated: ${manifest.created_at}\nStatus: ${manifest.status}\n`,

    `# Context Pack\n\n${contextPackBlocks.join('\n\n')}\n`,

    ...(omitSkillsSection ? [] : [`${skillsSectionContent}\n`]),

    `# Repository Instructions\n\nRead and follow repository instruction files before making changes:\n\n${instructionSection}`,

    ...(codegraphReady ? [renderAvailableRepoNavigationCommandsSection(manifest.run_id)] : []),

    ...(opts.coordinationSection ? [`${opts.coordinationSection}\n`] : []),

    `# Validation Expectations\n\n- Keep changes scoped to the requested task.\n- Run the relevant tests and checks listed above before reporting completion.\n- Do not introduce changes outside the stated scope.\n- Verify all modified files compile without errors.\n`,

    `# Output Requirements\n\n- Summarize what you changed and why.\n- List all files modified.\n- Report test results.\n- Note any remaining risks or follow-up items.\n- If any required test or check failed, report it explicitly.\n`,
  ];

  return sections.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function renderFinalPrompt(runDir: string, opts?: RenderOptions): PromptRenderResult {
  const warnings: string[] = [];

  try {
    // --- Required artifacts ---
    const userPromptPath = path.join(runDir, 'user_prompt.md');
    const manifestPath = path.join(runDir, 'run_manifest.json');
    const contextPackPath = path.join(runDir, 'output', 'context_pack.md');

    const userPrompt = readRequired(userPromptPath, 'USER_PROMPT_NOT_FOUND');
    const manifestRaw = readRequired(manifestPath, 'RUN_MANIFEST_NOT_FOUND');
    const contextPack = readRequired(contextPackPath, 'CONTEXT_PACK_NOT_FOUND');

    const manifest = JSON.parse(manifestRaw) as RunManifest;
    const task = userPrompt.trim();

    // Legacy flash-derived artifacts (`skills/selected_skills.json` and
    // `skills/selected_skill_contents.md`) are intentionally not read here.
    // The Selected Skills section is driven exclusively by the UI/CLI manual
    // selected-skills manifest below.

    // --- Optional artifacts ---
    const flashMetaPath = path.join(runDir, 'flash', 'flash_output_meta.json');
    const relevanceSelectionPath = path.join(runDir, 'flash', 'relevance_selection.json');
    const exactTextHitsPath = path.join(runDir, 'scan', 'exact_text_hits.json');
    const scanCommandsPath = path.join(runDir, 'scan', 'commands.json');
    const repoInstructionsPath = path.join(runDir, 'scan', 'repo_instructions.json');

    const flashMeta = readOptionalMeta(flashMetaPath);
    if (!flashMeta?.task_summary?.trim()) {
      warnings.push('Missing task_summary in flash_output_meta.json.');
    }

    const hitsArtifact = readOptionalJson<ExactTextHitsArtifact>(exactTextHitsPath);
    const selectionArtifact = readOptionalJson<RelevanceSelectionArtifact>(relevanceSelectionPath);

    const allExactGroups = collectExactTextGroups(hitsArtifact, selectionArtifact);

    // Canonical evidence: paths surfaced by the deterministic scanner or the
    // relevance ranker — authoritative beyond raw flash output.
    const canonicalEvidence = new Set<string>(allExactGroups.map((g) => g.path));
    if (Array.isArray(selectionArtifact?.selected_files)) {
      for (const sel of selectionArtifact.selected_files) {
        if (typeof sel.path === 'string' && sel.path.length > 0) {
          canonicalEvidence.add(sel.path);
        }
      }
    }

    // Tainted paths: any path that appeared with a speculation annotation in
    // any flash-provided list. Tainted paths require canonical evidence to
    // survive sanitization.
    const taintedPaths = collectTaintedPaths([
      flashMeta?.relevant_files,
      flashMeta?.files_to_read_with_tools,
      flashMeta?.relevant_tests,
    ]);

    const sanitizedRelevantFiles = sanitizeFileList(
      flashMeta?.relevant_files,
      taintedPaths,
      canonicalEvidence,
    );
    const sanitizedFilesToInspect = sanitizeFileList(
      flashMeta?.files_to_read_with_tools,
      taintedPaths,
      canonicalEvidence,
    );
    const sanitizedRelevantTests = sanitizeFileList(
      flashMeta?.relevant_tests,
      taintedPaths,
      canonicalEvidence,
    );

    const relevantSignals = new Set<string>([
      ...sanitizedRelevantTests,
      ...sanitizedRelevantFiles,
      ...sanitizedFilesToInspect,
    ]);
    const { kept: exactGroups, omittedCount: exactOmittedCount } = filterExactTextGroups(
      allExactGroups,
      relevantSignals,
    );

    const scanCommandsJson = readOptionalJson<{ commands?: unknown }>(scanCommandsPath);
    // The Python scanner may write commands as a categorised object {install,run,test}
    // or as a flat string array. Guard with Array.isArray so we never call .map on an object.
    const scanCommands = Array.isArray(scanCommandsJson?.commands)
      ? (scanCommandsJson.commands as string[])
      : [];

    const externalToolsPath = path.join(runDir, 'scan', 'external_tools.json');
    const externalToolsJson = readOptionalJson<{
      tools?: { codegraph?: { available?: unknown; initialized?: unknown } };
    }>(externalToolsPath);
    const codegraphReady = Boolean(
      externalToolsJson?.tools?.codegraph?.available === true &&
        externalToolsJson?.tools?.codegraph?.initialized === true,
    );

    const repoInstructionsJson = readOptionalJson<{
      files?: unknown;
      repo_instructions?: unknown;
    }>(repoInstructionsPath);
    const repoInstructionFiles: string[] = Array.isArray(repoInstructionsJson?.files)
      ? (repoInstructionsJson.files as string[])
      : Array.isArray(repoInstructionsJson?.repo_instructions)
        ? (repoInstructionsJson.repo_instructions as Array<{ path?: string }>)
            .map((r) => r.path ?? '')
            .filter(Boolean)
        : [];

    // --- UI-selected skills manifest (optional) ---
    const selectedSkillsManifest = readSelectedSkillsManifest(runDir);

    // --- Multi-agent coordination block (Phase 3B) ---
    // Explicit `coordination` (including null) wins; otherwise self-resolve from
    // the run's agent_binding.json + live coordination state when a repoRoot is
    // available. The block is part of final_prompt.md (the truth), never an
    // after-preview injection.
    let coordination: CoordinationPromptContext | null = null;
    if (opts?.coordination !== undefined) {
      coordination = opts.coordination;
    } else if (opts?.repoRoot) {
      const binding = readAgentBinding(runDir);
      coordination = buildCoordinationPromptContext(
        opts.repoRoot,
        binding,
        opts.now ? { now: opts.now } : {},
      );
    }
    const coordinationSection = coordination ? renderCoordinationSection(coordination) : '';

    // --- Render ---
    const content = buildFinalPrompt({
      task,
      manifest,
      contextPack,
      flashMeta,
      scanCommands,
      repoInstructionFiles,
      exactGroups,
      exactOmittedCount,
      sanitizedRelevantFiles,
      sanitizedFilesToInspect,
      rendererWarnings: warnings,
      codegraphReady,
      selectedSkillsManifest,
      coordinationSection,
    });

    // --- Write output/final_prompt.md ---
    const outputDir = path.join(runDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const finalPromptPath = path.join(outputDir, 'final_prompt.md');
    fs.writeFileSync(finalPromptPath, content, 'utf8');

    // --- Update current/ mirror ---
    const artifacts = [finalPromptPath];
    if (opts?.vibecodePath) {
      const currentDir = path.join(opts.vibecodePath, 'current');
      fs.mkdirSync(currentDir, { recursive: true });

      fs.writeFileSync(path.join(currentDir, 'run_manifest.json'), manifestRaw, 'utf8');
      fs.writeFileSync(path.join(currentDir, 'context_pack.md'), contextPack, 'utf8');
      if (selectedSkillsManifest) {
        fs.writeFileSync(
          path.join(currentDir, 'manifest.json'),
          `${JSON.stringify(selectedSkillsManifest, null, 2)}\n`,
          'utf8',
        );
      }
      fs.writeFileSync(path.join(currentDir, 'final_prompt.md'), content, 'utf8');
    }

    return {
      ok: true,
      runId: manifest.run_id,
      artifacts,
      warnings,
    };
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      'message' in err &&
      'details' in err
    ) {
      return { ok: false, error: err as PromptRenderError };
    }

    return {
      ok: false,
      error: {
        code: 'PROMPT_RENDER_FAILED',
        message: err instanceof Error ? err.message : String(err),
        details: [],
      },
    };
  }
}
