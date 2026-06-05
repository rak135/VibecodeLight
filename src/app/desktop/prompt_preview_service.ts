import fs from 'fs';
import path from 'path';

import type { CodeGraphContextMode } from '../../adapters/codegraph/codegraph_context.js';
import type { CodeGraphTransport } from '../../adapters/codegraph/codegraph_transport.js';
import type { TaskIntent } from '../../adapters/task_normalizer/types.js';
import { runPromptPipeline } from '../../core/prompting/pipeline.js';
import type { PipelineEvent, PipelineProgressCallback } from '../../core/prompting/pipeline_events.js';
import { readRunContextSummary, RunContextSummary } from '../../core/context/run_context_summary.js';
import { readRunCodeGraphStatus, CodeGraphStatus } from '../../core/scanning/codegraph_status.js';

export interface PromptPreviewRequest {
  task: string;
  repoRoot: string;
  /** Flash mode: 'mock' (default) or 'live'. */
  flashMode?: 'mock' | 'live';
  flashProvider?: string;
  flashModel?: string;
  codegraphMode?: CodeGraphContextMode;
  /** Pipeline transport selection (cli/mcp/auto). Defaults to cli. */
  codegraphTransport?: CodeGraphTransport;
  taskNormalizerEnabled?: boolean;
  onProgress?: PipelineProgressCallback;
  /** UI-selected repo-local skill ids; threaded into the run manifest. */
  selectedSkillIds?: readonly string[];
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
  taskIntent?: TaskIntent;
  taskNormalizerEnabled?: boolean;
  taskNormalizerOk?: boolean;
  taskNormalizerLanguage?: string;
  taskIntentPath?: string;
  /**
   * Optional CodeGraph detect-only status for this run, derived in core from
   * scan/external_tools.json. Informational only: CodeGraph is not used to build
   * the context/final prompt in this phase (see CodeGraphStatus.usageNote).
   */
  codegraph: CodeGraphStatus;
  /** Transport selection (cli/mcp/auto) requested for this run. */
  codegraphTransportRequested?: CodeGraphTransport;
  /** Transport that actually built the context, or 'none'. */
  codegraphTransportUsed?: 'cli' | 'mcp' | 'auto' | 'none';
  /** True when the run started on MCP and fell back to the CLI transport. */
  codegraphFallbackUsed?: boolean;
  /** Optional human-readable reason for the MCP→CLI fallback. */
  codegraphFallbackReason?: string;
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

function readTaskIntent(taskIntentPath: string | undefined): TaskIntent | undefined {
  if (!taskIntentPath || !fs.existsSync(taskIntentPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(taskIntentPath, 'utf8')) as TaskIntent;
  } catch {
    return undefined;
  }
}

interface CodeGraphTransportInfo {
  requested?: CodeGraphTransport;
  used?: 'cli' | 'mcp' | 'auto' | 'none';
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

function readCodeGraphTransportInfo(runDir: string): CodeGraphTransportInfo {
  const usagePath = path.join(runDir, 'scan', 'codegraph_usage.json');
  if (!fs.existsSync(usagePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(usagePath, 'utf8')) as Record<string, unknown>;
    const info: CodeGraphTransportInfo = {};
    if (parsed.transport_requested === 'cli' || parsed.transport_requested === 'mcp' || parsed.transport_requested === 'auto') {
      info.requested = parsed.transport_requested;
    }
    if (
      parsed.transport_used === 'cli' ||
      parsed.transport_used === 'mcp' ||
      parsed.transport_used === 'auto' ||
      parsed.transport_used === 'none'
    ) {
      info.used = parsed.transport_used;
    }
    if (typeof parsed.fallback_used === 'boolean') info.fallbackUsed = parsed.fallback_used;
    if (typeof parsed.fallback_reason === 'string') info.fallbackReason = parsed.fallback_reason;
    return info;
  } catch {
    return {};
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
    codegraphMode: request.codegraphMode,
    codegraphTransport: request.codegraphTransport,
    taskNormalizerEnabled: request.taskNormalizerEnabled === true,
    selectedSkillIds: request.selectedSkillIds,
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
  const taskIntent = readTaskIntent(pipelineResult.taskIntentPath);
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

  const transportInfo = readCodeGraphTransportInfo(pipelineResult.runDir);

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
    ...(taskIntent ? { taskIntent } : {}),
    taskNormalizerEnabled: pipelineResult.taskNormalizerEnabled,
    taskNormalizerOk: pipelineResult.taskNormalizerOk,
    taskNormalizerLanguage: pipelineResult.taskNormalizerLanguage,
    ...(pipelineResult.taskIntentPath ? { taskIntentPath: pipelineResult.taskIntentPath } : {}),
    codegraph: readRunCodeGraphStatus(pipelineResult.runDir),
    ...(transportInfo.requested ? { codegraphTransportRequested: transportInfo.requested } : {}),
    ...(transportInfo.used ? { codegraphTransportUsed: transportInfo.used } : {}),
    ...(typeof transportInfo.fallbackUsed === 'boolean' ? { codegraphFallbackUsed: transportInfo.fallbackUsed } : {}),
    ...(transportInfo.fallbackReason ? { codegraphFallbackReason: transportInfo.fallbackReason } : {}),
    terminalSend: 'not_sent',
    flash_mode: request.flashMode ?? 'mock',
    warnings: pipelineResult.warnings ?? [],
  };
}
