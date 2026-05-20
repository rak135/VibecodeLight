import fs from 'fs';
import path from 'path';

import { runPromptPipeline } from '../../core/prompting/pipeline.js';

export interface PromptPreviewRequest {
  task: string;
  repoRoot: string;
}

export interface PromptPreviewError {
  ok: false;
  error: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

export interface PromptPreviewSuccess {
  ok: true;
  run_id: string;
  runDir: string;
  finalPromptPath: string;
  contextPackPath: string;
  selectedSkillsPath: string;
  finalPrompt: string;
  terminalSend: 'not_sent';
  warnings: string[];
}

export type PromptPreviewResult = PromptPreviewSuccess | PromptPreviewError;

export async function generatePromptPreview(request: PromptPreviewRequest): Promise<PromptPreviewResult> {
  const task = (request.task ?? '').trim();
  if (task.length === 0) {
    return {
      ok: false,
      error: {
        code: 'TASK_REQUIRED',
        message: 'task prompt is required to generate a preview',
        details: ['The composer task prompt must not be empty or whitespace-only.'],
      },
    };
  }

  const repoRoot = request.repoRoot;
  if (!repoRoot || typeof repoRoot !== 'string') {
    return {
      ok: false,
      error: {
        code: 'REPO_ROOT_REQUIRED',
        message: 'repoRoot is required to generate a preview',
        details: [],
      },
    };
  }

  const pipelineResult = await runPromptPipeline({ task, repoRoot, mock: true });
  if (!pipelineResult.ok) {
    return {
      ok: false,
      error: {
        code: pipelineResult.error.code,
        message: pipelineResult.error.message,
        path: pipelineResult.error.path,
        details: pipelineResult.error.details,
      },
    };
  }

  const finalPromptPath = pipelineResult.finalPromptPath;
  let finalPrompt: string;
  try {
    finalPrompt = fs.readFileSync(finalPromptPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'FINAL_PROMPT_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
        path: finalPromptPath,
        details: [],
      },
    };
  }

  return {
    ok: true,
    run_id: pipelineResult.run_id,
    runDir: pipelineResult.runDir,
    finalPromptPath,
    contextPackPath: path.join(pipelineResult.runDir, 'output', 'context_pack.md'),
    selectedSkillsPath: path.join(pipelineResult.runDir, 'skills', 'selected_skills.json'),
    finalPrompt,
    terminalSend: 'not_sent',
    warnings: pipelineResult.warnings ?? [],
  };
}
