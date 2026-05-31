import fs from 'fs';
import path from 'path';

import type { FlashOutputMeta } from '../context/flash_output_meta.js';
import type { RunManifest } from '../models/index.js';

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
  skillContents: string;
  hasSelectedSkills: boolean;
  flashMeta: FlashOutputMeta | null;
  scanCommands: string[];
  repoInstructionFiles: string[];
  exactGroups: ExactGroup[];
  exactOmittedCount: number;
  rendererWarnings: string[];
}

function buildFinalPrompt(opts: BuildFinalPromptOptions): string {
  const {
    task,
    manifest,
    contextPack,
    skillContents,
    hasSelectedSkills,
    flashMeta,
    scanCommands,
    repoInstructionFiles,
    exactGroups,
    exactOmittedCount,
    rendererWarnings,
  } = opts;

  const exactPaths = exactGroups.map((g) => g.path);
  const exactTextLines = exactGroups.map(renderExactGroupLine);

  const relevantFiles = uniqueItems([
    ...exactPaths,
    ...(flashMeta?.relevant_files ?? []),
  ]);
  const filesToInspect = uniqueItems([
    ...exactPaths,
    ...(flashMeta?.files_to_read_with_tools ?? []),
  ]);
  const cautions = flashMeta?.cautions ?? [];
  const taskSummary = flashMeta?.task_summary?.trim() ?? '';
  const constraints = flashMeta?.constraints ?? [];
  const validationHints = flashMeta?.validation_hints ?? [];

  const commands = flashMeta?.commands_to_run?.length
    ? flashMeta.commands_to_run
    : scanCommands;

  const skillsSection =
    hasSelectedSkills && skillContents.trim().length > 0
      ? skillContents.trim()
      : '_No selected skills were provided for this run._';

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
    contextPackBlocks.push(contextPack.trim());
  }

  const sections: string[] = [
    `# Task\n\n${task.trim()}\n`,

    `# Repository Context\n\nRun ID: \`${manifest.run_id}\`\nCreated: ${manifest.created_at}\nStatus: ${manifest.status}\n`,

    `# Context Pack\n\n${contextPackBlocks.join('\n\n')}\n`,

    `# Selected Skills\n\n${skillsSection}\n`,

    `# Repository Instructions\n\nRead and follow repository instruction files before making changes:\n\n${instructionSection}`,

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
    const selectedSkillsPath = path.join(runDir, 'skills', 'selected_skills.json');
    const selectedSkillContentsPath = path.join(runDir, 'skills', 'selected_skill_contents.md');

    const userPrompt = readRequired(userPromptPath, 'USER_PROMPT_NOT_FOUND');
    const manifestRaw = readRequired(manifestPath, 'RUN_MANIFEST_NOT_FOUND');
    const contextPack = readRequired(contextPackPath, 'CONTEXT_PACK_NOT_FOUND');
    const selectedSkillsRaw = readRequired(selectedSkillsPath, 'SELECTED_SKILLS_NOT_FOUND');
    const skillContents = readRequired(selectedSkillContentsPath, 'SELECTED_SKILL_CONTENTS_NOT_FOUND');

    const manifest = JSON.parse(manifestRaw) as RunManifest;
    const task = userPrompt.trim();

    const selectedSkillsData = JSON.parse(selectedSkillsRaw) as {
      selected_skills?: string[];
      selected?: string[];
    };
    const selectedSkillsList =
      selectedSkillsData.selected_skills ?? selectedSkillsData.selected ?? [];
    const hasSelectedSkills = selectedSkillsList.length > 0;

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
    const relevantSignals = new Set<string>([
      ...(flashMeta?.relevant_tests ?? []),
      ...(flashMeta?.relevant_files ?? []),
      ...(flashMeta?.files_to_read_with_tools ?? []),
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

    // --- Render ---
    const content = buildFinalPrompt({
      task,
      manifest,
      contextPack,
      skillContents,
      hasSelectedSkills,
      flashMeta,
      scanCommands,
      repoInstructionFiles,
      exactGroups,
      exactOmittedCount,
      rendererWarnings: warnings,
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
      fs.writeFileSync(path.join(currentDir, 'selected_skills.json'), selectedSkillsRaw, 'utf8');
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
