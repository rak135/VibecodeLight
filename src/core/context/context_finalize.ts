import fs from 'fs';
import path from 'path';

import type { SkillsCatalog } from '../models/index.js';
import { parseFlashOutput } from './markdown_flash_output_parser.js';
import { writeContextPack } from './context_pack_store.js';
import { writeSelectedSkills } from './selected_skills.js';
import { writeSelectedSkillContents } from './selected_skill_contents.js';

export interface ContextFinalizeDiagnostic {
  code: string;
  message: string;
  path: string;
  details: string[];
}

export class ContextFinalizeError extends Error {
  code: string;
  path: string;
  details: string[];

  constructor(message: string, diagnostic: { code: string; path: string; details?: string[] }) {
    super(message);
    this.name = 'ContextFinalizeError';
    this.code = diagnostic.code;
    this.path = diagnostic.path;
    this.details = diagnostic.details ?? [];
  }

  toDiagnostic(): ContextFinalizeDiagnostic {
    return {
      code: this.code,
      message: this.message,
      path: this.path,
      details: this.details,
    };
  }
}

export interface ContextFinalizeResult {
  run_id: string;
  artifacts: string[];
  warnings: string[];
  missing_skills: string[];
}

function readRunId(runDir: string): string {
  const manifestPath = path.join(runDir, 'run_manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { run_id?: unknown };
    if (typeof manifest.run_id === 'string' && manifest.run_id.trim()) {
      return manifest.run_id;
    }
  } catch {
    // Keep finalization tolerant of older/debug runs without a valid manifest.
  }
  return path.basename(runDir);
}

function readSkillsCatalog(catalogPath: string): SkillsCatalog {
  if (!fs.existsSync(catalogPath)) {
    throw new ContextFinalizeError('missing skills_catalog.json for context finalize', {
      code: 'SKILLS_CATALOG_NOT_FOUND',
      path: catalogPath,
      details: ['Run context-build first, or choose a run containing skills/skills_catalog.json.'],
    });
  }

  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as SkillsCatalog;
    if (!catalog || !Array.isArray(catalog.skills) || !Array.isArray(catalog.warnings)) {
      throw new Error('skills catalog must contain skills and warnings arrays');
    }
    return catalog;
  } catch (error) {
    if (error instanceof ContextFinalizeError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ContextFinalizeError(`invalid skills_catalog.json: ${message}`, {
      code: 'SKILLS_CATALOG_INVALID',
      path: catalogPath,
      details: [message],
    });
  }
}

export function contextFinalizeErrorToDiagnostic(error: unknown, fallbackPath: string): ContextFinalizeDiagnostic {
  if (error instanceof ContextFinalizeError) {
    return error.toDiagnostic();
  }

  const typed = error as Partial<Error> & { code?: string; path?: string; details?: string[] };
  return {
    code: typeof typed.code === 'string' ? typed.code : 'CONTEXT_FINALIZE_FAILED',
    message: error instanceof Error ? error.message : String(error),
    path: typeof typed.path === 'string' ? typed.path : fallbackPath,
    details: Array.isArray(typed.details) ? typed.details : [],
  };
}

export function finalizeContext(runDir: string): ContextFinalizeResult {
  const flashOutputPath = path.join(runDir, 'flash', 'flash_output.md');
  if (!fs.existsSync(flashOutputPath)) {
    throw new ContextFinalizeError('missing flash_output.md for context finalize', {
      code: 'FLASH_OUTPUT_NOT_FOUND',
      path: flashOutputPath,
      details: ['Run flash run before context finalize, or choose a run containing flash/flash_output.md.'],
    });
  }

  let flashOutputMd: string;
  try {
    flashOutputMd = fs.readFileSync(flashOutputPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ContextFinalizeError(`unable to read flash_output.md: ${message}`, {
      code: 'FLASH_OUTPUT_READ_FAILED',
      path: flashOutputPath,
      details: [message],
    });
  }

  const parsed = parseFlashOutput(flashOutputMd, flashOutputPath);
  if (!parsed.ok) {
    throw new ContextFinalizeError(parsed.diagnostic?.message ?? 'flash output invalid', {
      code: parsed.diagnostic?.code ?? 'FLASH_OUTPUT_INVALID',
      path: parsed.diagnostic?.path ?? flashOutputPath,
      details: parsed.diagnostic?.details ?? [],
    });
  }

  const contextPackPath = writeContextPack(runDir, flashOutputMd);
  const catalogPath = path.join(runDir, 'skills', 'skills_catalog.json');
  const catalog = readSkillsCatalog(catalogPath);
  const selectedSkills = writeSelectedSkills(runDir, parsed.sections, catalog);
  const selectedSkillContents = writeSelectedSkillContents(runDir, selectedSkills.data);
  const warnings = [
    ...catalog.warnings,
    ...selectedSkills.data.warnings,
    ...selectedSkillContents.warnings,
  ];

  return {
    run_id: readRunId(runDir),
    artifacts: [contextPackPath, selectedSkills.path, selectedSkillContents.path],
    warnings,
    missing_skills: selectedSkills.data.missing_skills,
  };
}
