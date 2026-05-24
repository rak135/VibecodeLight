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

interface BuildFinalPromptOptions {
  task: string;
  manifest: RunManifest;
  contextPack: string;
  skillContents: string;
  hasSelectedSkills: boolean;
  flashMeta: FlashOutputMeta | null;
  scanCommands: string[];
  repoInstructionFiles: string[];
}

function buildFinalPrompt(opts: BuildFinalPromptOptions): string {
  const { task, manifest, contextPack, skillContents, hasSelectedSkills, flashMeta, scanCommands, repoInstructionFiles } = opts;

  const relevantFiles = flashMeta?.relevant_files ?? [];
  const filesToInspect = flashMeta?.files_to_read_with_tools ?? [];
  const cautions = flashMeta?.cautions ?? [];

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

  const sections: string[] = [
    `# Task\n\n${task.trim()}\n`,

    `# Repository Context\n\nRun ID: \`${manifest.run_id}\`\nCreated: ${manifest.created_at}\nStatus: ${manifest.status}\n`,

    `# Context Pack\n\n${contextPack.trim()}\n`,

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
    const scanCommandsPath = path.join(runDir, 'scan', 'commands.json');
    const repoInstructionsPath = path.join(runDir, 'scan', 'repo_instructions.json');

    const flashMeta = readOptionalMeta(flashMetaPath);

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
