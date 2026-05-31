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
// Template builder
// ---------------------------------------------------------------------------

function listItems(items: string[]): string {
  if (items.length === 0) return '_None_\n';
  return items.map((item) => `- ${item}`).join('\n') + '\n';
}

function uniqueItems(items: string[]): string[] {
  return Array.from(new Set(items));
}

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

function exactTextSelectionItems(selection: RelevanceSelectionArtifact | null): string[] {
  const items = Array.isArray(selection?.selected_files) ? selection.selected_files : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item.path !== 'string' || item.path.length === 0) continue;
    const reasons = Array.isArray(item.reasons)
      ? item.reasons.filter((reason): reason is string => typeof reason === 'string')
      : [];
    const exactReasons = reasons.filter((reason) => reason.toLowerCase().includes('exact text match'));
    if (exactReasons.length === 0) continue;
    out.push(`${item.path} — selected by: ${exactReasons.join('; ')}`);
  }
  return uniqueItems(out);
}

function exactTextHitItems(hits: ExactTextHitsArtifact | null): string[] {
  const items = Array.isArray(hits?.exact_text_hits) ? hits.exact_text_hits : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item.path !== 'string' || item.path.length === 0) continue;
    if (typeof item.term !== 'string' || item.term.length === 0) continue;
    const location = typeof item.line === 'number' ? ` line ${item.line}` : '';
    out.push(`${item.path}${location} — exact text match: "${item.term}"`);
  }
  return uniqueItems(out);
}

interface BuildFinalPromptOptions {
  task: string;
  manifest: RunManifest;
  contextPack: string;
  skillContents: string;
  hasSelectedSkills: boolean;
  flashMeta: FlashOutputMeta | null;
  scanCommands: string[];
  repoInstructionFiles: string[];
  deterministicRelevantFiles: string[];
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
    deterministicRelevantFiles,
    rendererWarnings,
  } = opts;

  const relevantFiles = uniqueItems([...(flashMeta?.relevant_files ?? [])]);
  const filesToInspect = uniqueItems([...deterministicRelevantFiles, ...(flashMeta?.files_to_read_with_tools ?? [])]);
  const cautions = flashMeta?.cautions ?? [];
  const taskSummary = flashMeta?.task_summary?.trim() ?? '';
  const constraints = flashMeta?.constraints ?? [];
  const validationHints = flashMeta?.validation_hints ?? [];

  // Commands: prefer flash meta, fall back to scan commands
  const commands = flashMeta?.commands_to_run?.length
    ? flashMeta.commands_to_run
    : scanCommands;

  // Skills section: use selected_skills.json to determine if skills were actually selected,
  // not just whether selected_skill_contents.md is non-empty (it may contain a header with no bodies).
  const skillsSection = hasSelectedSkills && skillContents.trim().length > 0
    ? skillContents.trim()
    : '_No selected skills were provided for this run._';

  // Instruction files section
  const instructionSection = repoInstructionFiles.length > 0
    ? listItems(repoInstructionFiles)
    : '_No repository instruction files detected._\n';

  const contextPackBlocks: string[] = [];
  if (rendererWarnings.length > 0) {
    contextPackBlocks.push(`## Renderer Warnings\n${listItems(rendererWarnings).trimEnd()}`);
  }
  if (taskSummary) {
    contextPackBlocks.push(`## Task Summary\n${taskSummary}`);
  }
  contextPackBlocks.push(`## Constraints\n${listItems(constraints).trimEnd()}`);
  contextPackBlocks.push(`## Validation Hints\n${listItems(validationHints).trimEnd()}`);
  if (deterministicRelevantFiles.length > 0) {
    contextPackBlocks.push(`## Exact Text Matches\n${listItems(deterministicRelevantFiles).trimEnd()}`);
  }
  contextPackBlocks.push(`## Relevant Files\n${listItems(relevantFiles).trimEnd()}`);
  contextPackBlocks.push(`## Files To Inspect\n${listItems(filesToInspect).trimEnd()}`);
  contextPackBlocks.push(`## Suggested Commands\n${listItems(commands).trimEnd()}`);
  contextPackBlocks.push(`## Cautions\n${listItems(cautions).trimEnd()}`);
  if (contextPack.trim().length > 0) {
    contextPackBlocks.push(contextPack.trim());
  }

  const sections: string[] = [
    `# Task\n\n${task.trim()}\n`,

    `# Repository Context\n\nRun ID: \`${manifest.run_id}\`\nCreated: ${manifest.created_at}\nStatus: ${manifest.status}\n`,

    `# Context Pack\n\n${contextPackBlocks.join('\n\n')}\n`,

    `# Selected Skills\n\n${skillsSection}\n`,

    `# Relevant Files\n\n${listItems(relevantFiles)}`,

    `# Files To Inspect\n\n${listItems(filesToInspect)}`,

    `# Suggested Commands\n\n${listItems(commands)}`,

    `# Cautions\n\n${listItems(cautions)}`,

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

    // Determine if any skills were actually selected (use the JSON, not file contents)
    const selectedSkillsData = JSON.parse(selectedSkillsRaw) as { selected_skills?: string[]; selected?: string[] };
    const selectedSkillsList = selectedSkillsData.selected_skills ?? selectedSkillsData.selected ?? [];
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
    const deterministicRelevantFiles = uniqueItems([
      ...exactTextHitItems(readOptionalJson<ExactTextHitsArtifact>(exactTextHitsPath)),
      ...exactTextSelectionItems(readOptionalJson<RelevanceSelectionArtifact>(relevanceSelectionPath)),
    ]);

    const scanCommandsJson = readOptionalJson<{ commands?: unknown }>(scanCommandsPath);
    // The Python scanner may write commands as a categorised object {install,run,test}
    // or as a flat string array. Guard with Array.isArray so we never call .map on an object.
    const scanCommands = Array.isArray(scanCommandsJson?.commands) ? (scanCommandsJson.commands as string[]) : [];

    // repo_instructions.json may have { files: string[] } or { repo_instructions: Array<{path,content}> }
    // The Python scanner writes the latter format; accept both shapes gracefully.
    const repoInstructionsJson = readOptionalJson<{ files?: unknown; repo_instructions?: unknown }>(repoInstructionsPath);
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
      deterministicRelevantFiles,
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
    // If it's a structured PromptRenderError thrown by readRequired
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
