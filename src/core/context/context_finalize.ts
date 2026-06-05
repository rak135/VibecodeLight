import fs from 'fs';
import path from 'path';

import { parseFlashOutput } from './markdown_flash_output_parser.js';
import { writeContextPack } from './context_pack_store.js';
import {
  buildSelectedSkillsManifest,
  SelectedSkillsManifestError,
  writeSelectedSkillsManifest,
} from '../skills/selected_manifest.js';

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

export interface ContextFinalizeOptions {
  /**
   * UI/CLI-selected skill ids. The only source of selected skills in the new
   * manual-only flow. When provided alongside `repoRoot`, a
   * `skills/manifest.json` is written with only the metadata of selected
   * skills. Full skill bodies are not embedded. Flash output's
   * `# Selected Skills` section is ignored regardless of this option.
   */
  selectedSkillIds?: readonly string[];
  /** Required to resolve selected skill source paths in <repoRoot>/SKILLS. */
  repoRoot?: string;
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

export function finalizeContext(
  runDir: string,
  opts: ContextFinalizeOptions = {},
): ContextFinalizeResult {
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

  // Flash output's `# Selected Skills` section is intentionally NOT consulted.
  // Manual selectedSkillIds are the only source of selected skills.
  const contextPackPath = writeContextPack(runDir, flashOutputMd);

  const warnings: string[] = [];
  const artifacts: string[] = [contextPackPath];

  if (opts.selectedSkillIds && opts.selectedSkillIds.length > 0 && opts.repoRoot) {
    try {
      const built = buildSelectedSkillsManifest({
        runId: readRunId(runDir),
        repoRoot: opts.repoRoot,
        selectedSkillIds: opts.selectedSkillIds,
      });
      const manifestPath = writeSelectedSkillsManifest(runDir, built.manifest);
      artifacts.push(manifestPath);
      warnings.push(...built.warnings);
    } catch (error) {
      if (error instanceof SelectedSkillsManifestError) {
        throw new ContextFinalizeError(error.message, {
          code: error.code,
          path: error.path ?? path.join(runDir, 'skills', 'manifest.json'),
          details: error.details,
        });
      }
      throw error;
    }
  }

  return {
    run_id: readRunId(runDir),
    artifacts,
    warnings,
    missing_skills: [],
  };
}
