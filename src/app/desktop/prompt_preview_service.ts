import fs from 'fs';
import path from 'path';

import { runPromptPipeline } from '../../core/prompting/pipeline.js';
import type { PipelineEvent, PipelineProgressCallback } from '../../core/prompting/pipeline_events.js';
import { readRunContextSummary, RunContextSummary } from '../../core/context/run_context_summary.js';

export interface PromptPreviewRequest {
  task: string;
  repoRoot: string;
  /** Flash mode: 'mock' (default) or 'live'. */
  flashMode?: 'mock' | 'live';
  flashProvider?: string;
  flashModel?: string;
  onProgress?: PipelineProgressCallback;
}

export interface PromptPreviewError {
  ok: false;
  error: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
  providerErrorPath?: string;
  artifacts?: string[];
}

export interface PromptPreviewSuccess {
  ok: true;
  run_id: string;
  runDir: string;
  finalPromptPath: string;
  flashInputPath?: string;
  repoAtlasPath?: string;
  taskSlicePath?: string;
  relevanceSelectionPath?: string;
  flashInputBudgetPath?: string;
  estimatedTokens?: number;
  hardMaxTokens?: number;
  providerCalled?: boolean;
  budgetStatus?: 'ok' | 'FLASH_INPUT_BUDGET_EXCEEDED';
  contextPackPath: string;
  selectedSkillsPath: string;
  finalPrompt: string;
  flashOutputPath?: string;
  flashOutputContent?: string;
  providerErrorPath?: string;
  context: RunContextSummary;
  terminalSend: 'not_sent';
  /** The flash mode that was used for this run: mock or live. */
  flash_mode: 'mock' | 'live';
  warnings: string[];
}

export type PromptPreviewResult = PromptPreviewSuccess | PromptPreviewError;
export type PipelineProgressEvent = PipelineEvent;

const FLASH_OUTPUT_INLINE_LIMIT_BYTES = 50 * 1024;

function findProviderErrorPath(artifacts: string[] | undefined): string | undefined {
  return artifacts?.find((artifact) => artifact.replace(/\\/g, '/').endsWith('/flash/provider_error.json'));
}

function readTextFilePrefix(filePath: string, maxBytes: number): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

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

  const pipelineResult = await runPromptPipeline({
    task,
    repoRoot,
    mock: request.flashMode !== 'live',
    live: request.flashMode === 'live',
    flashProvider: request.flashProvider,
    flashModel: request.flashModel,
    onProgress: request.onProgress,
  });
  if (pipelineResult.ok === false) {
    const error = pipelineResult.error;
    const artifacts = error.artifacts ?? [];
    const providerErrorPath = findProviderErrorPath(artifacts);
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        path: error.path,
        details: error.details,
      },
      ...(providerErrorPath ? { providerErrorPath } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
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

  const flashOutputPath = path.join(pipelineResult.runDir, 'flash', 'flash_output.md');
  const flashOutputContent = readTextFilePrefix(flashOutputPath, FLASH_OUTPUT_INLINE_LIMIT_BYTES);
  const providerErrorPath = fs.existsSync(path.join(pipelineResult.runDir, 'flash', 'provider_error.json'))
    ? path.join(pipelineResult.runDir, 'flash', 'provider_error.json')
    : undefined;
  let budgetStatus: 'ok' | 'FLASH_INPUT_BUDGET_EXCEEDED' | undefined;
  if (pipelineResult.flashInputBudgetPath && fs.existsSync(pipelineResult.flashInputBudgetPath)) {
    try {
      const budget = JSON.parse(fs.readFileSync(pipelineResult.flashInputBudgetPath, 'utf8')) as { budget_status?: unknown };
      if (budget.budget_status === 'ok' || budget.budget_status === 'FLASH_INPUT_BUDGET_EXCEEDED') {
        budgetStatus = budget.budget_status;
      }
    } catch {
      // Best-effort diagnostics only.
    }
  }

  return {
    ok: true,
    run_id: pipelineResult.run_id,
    runDir: pipelineResult.runDir,
    finalPromptPath,
    ...(pipelineResult.flashInputPath ? { flashInputPath: pipelineResult.flashInputPath } : {}),
    ...(pipelineResult.repoAtlasPath ? { repoAtlasPath: pipelineResult.repoAtlasPath } : {}),
    ...(pipelineResult.taskSlicePath ? { taskSlicePath: pipelineResult.taskSlicePath } : {}),
    ...(pipelineResult.relevanceSelectionPath ? { relevanceSelectionPath: pipelineResult.relevanceSelectionPath } : {}),
    ...(pipelineResult.flashInputBudgetPath ? { flashInputBudgetPath: pipelineResult.flashInputBudgetPath } : {}),
    ...(typeof pipelineResult.estimatedTokens === 'number' ? { estimatedTokens: pipelineResult.estimatedTokens } : {}),
    ...(typeof pipelineResult.hardMaxTokens === 'number' ? { hardMaxTokens: pipelineResult.hardMaxTokens } : {}),
    ...(typeof pipelineResult.providerCalled === 'boolean' ? { providerCalled: pipelineResult.providerCalled } : {}),
    ...(budgetStatus ? { budgetStatus } : {}),
    contextPackPath: path.join(pipelineResult.runDir, 'output', 'context_pack.md'),
    selectedSkillsPath: path.join(pipelineResult.runDir, 'skills', 'selected_skills.json'),
    finalPrompt,
    ...(fs.existsSync(flashOutputPath) ? { flashOutputPath } : {}),
    ...(flashOutputContent !== undefined ? { flashOutputContent } : {}),
    ...(providerErrorPath ? { providerErrorPath } : {}),
    context: readRunContextSummary(pipelineResult.runDir),
    terminalSend: 'not_sent',
    flash_mode: request.flashMode ?? 'mock',
    warnings: pipelineResult.warnings ?? [],
  };
}
