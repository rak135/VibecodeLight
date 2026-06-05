import fs from 'fs';

import { LlmAdapterError } from '../../adapters/llm/errors.js';
import { contextFinalizeErrorToDiagnostic, finalizeContext } from '../context/index.js';

export interface ContextFinalizePhaseOptions {
  runId: string;
  runDir: string;
  /** Repo root for resolving skill source paths when writing the manifest. */
  repoRoot?: string;
  /** UI-selected repo-local skill ids to record in the manifest. */
  selectedSkillIds?: readonly string[];
}

export interface ContextFinalizePhaseResult {
  status: 'ok' | 'error';
  run_id?: string;
  runDir?: string;
  artifacts?: string[];
  warnings?: string[];
  missing_skills?: string[];
  error?: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

function llmAdapterErrorToEnvelope(
  error: LlmAdapterError,
  fallbackPath?: string,
): NonNullable<ContextFinalizePhaseResult['error']> {
  return {
    code: error.code,
    message: error.message,
    path: error.path ?? fallbackPath,
    details: error.details,
  };
}

export async function performContextFinalizePhase(
  opts: ContextFinalizePhaseOptions,
): Promise<ContextFinalizePhaseResult> {
  const { runId, runDir } = opts;

  try {
    if (!fs.existsSync(runDir)) {
      throw new LlmAdapterError(`run not found: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        path: runDir,
        details: [],
      });
    }

    const result = finalizeContext(runDir, {
      selectedSkillIds: opts.selectedSkillIds,
      repoRoot: opts.repoRoot,
    });
    return {
      status: 'ok',
      run_id: result.run_id,
      runDir,
      artifacts: result.artifacts,
      warnings: result.warnings,
      missing_skills: result.missing_skills,
    };
  } catch (error) {
    const diagnostic = error instanceof LlmAdapterError
      ? llmAdapterErrorToEnvelope(error, runDir)
      : contextFinalizeErrorToDiagnostic(error, runDir);
    return {
      status: 'error',
      run_id: runId,
      runDir,
      error: diagnostic,
    };
  }
}
