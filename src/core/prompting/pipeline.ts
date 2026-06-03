import fs from 'fs';
import path from 'path';

import type { LlmAdapter } from '../../adapters/llm/base.js';
import { buildCodeGraphContext, writeCodeGraphContextArtifacts, type CodeGraphContextMode } from '../../adapters/codegraph/codegraph_context.js';
import { DEFAULT_CODEGRAPH_TRANSPORT, type CodeGraphTransport } from '../../adapters/codegraph/codegraph_transport.js';
import type { CodeGraphMcpContextRunner } from '../../adapters/codegraph/codegraph_mcp.js';
import { LlmAdapterError } from '../../adapters/llm/errors.js';
import { MockFlashAdapter } from '../../adapters/llm/mock_flash.js';
import { OpenAiCompatibleAdapter } from '../../adapters/llm/openai_compatible_adapter.js';
import { runTaskNormalizer, writeTaskIntentArtifacts, type TaskIntent } from '../../adapters/task_normalizer/index.js';
import {
  ensureLocalConfig,
  resolveFlashConfig,
  writeConfigResolution,
} from '../config/index.js';
import {
  buildCompactFlashContext,
  buildFlashInputManifest,
  contextFinalizeErrorToDiagnostic,
  enrichFlashOutputMeta,
  finalizeContext,
  formatPreviousRunSummary,
  getPreviousRunSummary,
  markFlashInputProviderCalled,
} from '../context/index.js';
import { buildCodeGraphTask } from './codegraph_task.js';
import { renderFinalPrompt } from './renderer.js';
import { resolveFlashSystemPrompt, writeFlashSystemPromptArtifacts } from '../../core/prompts/flash_system_prompt.js';
import type {
  PipelineEvent,
  PipelineEventPhase,
  PipelineEventStatus,
  PipelineProgressCallback,
} from './pipeline_events.js';
import { updateCurrent } from '../runs/current.js';
import { augmentExternalToolsWithCodeGraphContext } from '../scanning/external_tools.js';
import { performScanPhase, writeRunManifest } from '../runs/scan_phase.js';
import type { RunManifest } from '../models/index.js';

export interface PromptPipelineOptions {
  task: string;
  repoRoot: string;
  mock: boolean;
  live?: boolean;
  adapter?: LlmAdapter;
  codegraphMode?: CodeGraphContextMode;
  /** Pipeline transport selection for the CodeGraph context build (Phase 1B). */
  codegraphTransport?: CodeGraphTransport;
  /** Test seam: inject an MCP context runner without spawning a real server. */
  codegraphMcpRunner?: CodeGraphMcpContextRunner;
  flashProvider?: string;
  flashModel?: string;
  taskNormalizerEnabled?: boolean;
  onProgress?: PipelineProgressCallback;
}

export interface PromptPipelineSuccess {
  ok: true;
  run_id: string;
  runDir: string;
  finalPromptPath: string;
  flashInputPath?: string;
  repoAtlasPath?: string;
  taskSlicePath?: string;
  relevanceSelectionPath?: string;
  flashInputBudgetPath?: string;
  taskIntentPath?: string;
  taskNormalizerEnabled?: boolean;
  taskNormalizerOk?: boolean;
  taskNormalizerLanguage?: string;
  estimatedTokens?: number;
  hardMaxTokens?: number;
  providerCalled?: boolean;
  artifacts: string[];
  warnings: string[];
  /** Path to the streamed progress event log for this run. */
  progressEventsPath?: string;
}

export interface PromptPipelineError {
  ok: false;
  error: {
    code: string;
    message: string;
    path?: string;
    details: string[];
    artifacts?: string[];
  };
}

export type PromptPipelineResult = PromptPipelineSuccess | PromptPipelineError;

interface PipelineEventInput {
  phase: PipelineEventPhase;
  status: PipelineEventStatus;
  label: string;
  message: string;
  detail?: string;
  duration_ms?: number;
  run_id?: string;
  provider_id?: string;
  model_id?: string;
  artifact_path?: string;
  chunk?: string;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

const BUNDLED_FLASH_SYSTEM_PROMPT_PATH = path.resolve(__dirname, '../../../resources/prompts/flash_system.md');

function errorResult(code: string, message: string, pathValue = '', details: string[] = []): PromptPipelineError {
  return {
    ok: false,
    error: {
      code,
      message,
      path: pathValue,
      details,
    },
  };
}

function readExactTextHitsSummary(scanDir: string): { phrases: number; hits: number } | undefined {
  const exactPath = path.join(scanDir, 'exact_text_hits.json');
  if (!fs.existsSync(exactPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(exactPath, 'utf8')) as {
      exact_phrases?: unknown[];
      exact_text_hits?: unknown[];
    };
    return {
      phrases: Array.isArray(parsed.exact_phrases) ? parsed.exact_phrases.length : 0,
      hits: Array.isArray(parsed.exact_text_hits) ? parsed.exact_text_hits.length : 0,
    };
  } catch {
    return undefined;
  }
}

type ScanPhaseResult = Awaited<ReturnType<typeof performScanPhase>>;
type SuccessfulScanPhaseResult = Extract<ScanPhaseResult, { status: 'ok' }>;
type TaskIntentArtifactPaths = ReturnType<typeof writeTaskIntentArtifacts>;

type PipelineWarningDetail = {
  label: string;
  message: string;
  detail?: string;
  artifact_path?: string;
};

interface PipelineProgressController {
  emitProgress: (input: PipelineEventInput) => PipelineEvent;
  redactSecrets: (message: string, secrets: Array<string | undefined>) => string;
  bootstrapProgressLog: (runDir: string) => string;
  getElapsedMs: () => number;
  getProgressEventsPath: () => string | undefined;
}

interface PipelineWarningCollector {
  warnings: string[];
  warningDetails: PipelineWarningDetail[];
  addWarnings: (
    label: string,
    items: readonly string[] | undefined,
    opts?: { detail?: string; artifact_path?: string },
  ) => void;
}

interface TaskNormalizerStepResult {
  taskNormalizerEnabled: boolean;
  taskIntent: TaskIntent;
}

interface ScanBootstrapResult {
  scan: ScanPhaseResult;
  taskIntentArtifactPaths: TaskIntentArtifactPaths;
}

interface CodeGraphStepResult {
  flashDir: string;
  codegraphResult: Awaited<ReturnType<typeof buildCodeGraphContext>>;
  codegraphArtifacts: ReturnType<typeof writeCodeGraphContextArtifacts>;
}

interface FlashInputStepResult {
  compactResult: ReturnType<typeof buildCompactFlashContext>;
  compactBudget: ReturnType<typeof buildCompactFlashContext>['budget'];
  flashInputPath: string;
  repoAtlasPath: string;
  taskSlicePath: string;
  relevanceSelectionPath: string;
  flashInputBudgetPath: string;
  resolvedSystemPrompt: ReturnType<typeof resolveFlashSystemPrompt>;
}

function createProgressEmitter(opts: PromptPipelineOptions): PipelineProgressController {
  const startTime = Date.now();
  const emittedEvents: PipelineEvent[] = [];
  let progressEventsPath: string | undefined;

  const persistEvent = (event: PipelineEvent): void => {
    if (!progressEventsPath) return;
    try {
      fs.appendFileSync(progressEventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // Persistence is best-effort and must never break the pipeline.
    }
  };

  const emitProgress = (input: PipelineEventInput): PipelineEvent => {
    const event: PipelineEvent = {
      phase: input.phase,
      status: input.status,
      label: input.label,
      message: input.message,
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - startTime,
    };
    if (input.detail !== undefined) event.detail = input.detail;
    if (input.duration_ms !== undefined) event.duration_ms = input.duration_ms;
    if (input.run_id !== undefined) event.run_id = input.run_id;
    if (input.provider_id !== undefined) event.provider_id = input.provider_id;
    if (input.model_id !== undefined) event.model_id = input.model_id;
    if (input.artifact_path !== undefined) event.artifact_path = input.artifact_path;
    if (input.chunk !== undefined) event.chunk = input.chunk;
    emittedEvents.push(event);
    persistEvent(event);
    try {
      opts.onProgress?.(event);
    } catch {
      // Renderer/CLI callback failures must not stop the pipeline.
    }
    return event;
  };

  const redactSecrets = (message: string, secrets: Array<string | undefined>): string => {
    let safeMessage = message;
    for (const secret of secrets) {
      if (secret) safeMessage = safeMessage.split(secret).join('[REDACTED]');
    }
    return safeMessage;
  };

  const bootstrapProgressLog = (runDir: string): string => {
    const outputDir = path.join(runDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    progressEventsPath = path.join(outputDir, 'progress_events.jsonl');
    try {
      fs.writeFileSync(
        progressEventsPath,
        `${emittedEvents.map((event) => JSON.stringify(event)).join('\n')}${emittedEvents.length ? '\n' : ''}`,
        'utf8',
      );
    } catch {
      // best-effort persistence
    }
    return progressEventsPath;
  };

  return {
    emitProgress,
    redactSecrets,
    bootstrapProgressLog,
    getElapsedMs: () => Date.now() - startTime,
    getProgressEventsPath: () => progressEventsPath,
  };
}

function createWarningCollector(): PipelineWarningCollector {
  const warnings: string[] = [];
  const warningDetails: PipelineWarningDetail[] = [];

  const addWarnings = (
    label: string,
    items: readonly string[] | undefined,
    opts: { detail?: string; artifact_path?: string } = {},
  ): void => {
    if (!items || items.length === 0) return;
    for (const item of items) {
      warnings.push(item);
      const entry: PipelineWarningDetail = { label, message: item };
      if (opts.detail !== undefined) entry.detail = opts.detail;
      if (opts.artifact_path !== undefined) entry.artifact_path = opts.artifact_path;
      warningDetails.push(entry);
    }
  };

  return { warnings, warningDetails, addWarnings };
}

function codeGraphTransportLabel(transport: CodeGraphTransport): string {
  return transport === 'mcp' ? 'MCP' : transport === 'auto' ? 'Auto' : 'CLI';
}

async function runTaskNormalizerStep(
  opts: PromptPipelineOptions,
  resolved: ReturnType<typeof resolveFlashConfig>,
  emitProgress: PipelineProgressController['emitProgress'],
): Promise<TaskNormalizerStepResult> {
  const taskNormalizerEnabled = opts.taskNormalizerEnabled ?? false;
  const normalizerProviderConfig = opts.mock ? undefined : resolved.providerConfig ?? undefined;

  if (!taskNormalizerEnabled) {
    emitProgress({
      phase: 'task_normalizer_skipped',
      status: 'skipped',
      label: 'Task Normalizer',
      message: 'Task Normalizer off.',
    });
  } else {
    emitProgress({
      phase: 'task_normalizer_started',
      status: 'started',
      label: 'Task Normalizer',
      message: 'Normalizing task into English search hints.',
    });
  }

  const taskNormalizerStart = Date.now();
  const taskIntent = await runTaskNormalizer({
    task: opts.task,
    enabled: taskNormalizerEnabled,
    providerConfig: normalizerProviderConfig,
    modelInfo: normalizerProviderConfig
      ? {
          provider: resolved.resolution.provider ?? 'unknown',
          model: resolved.resolution.model ?? 'unknown',
        }
      : undefined,
  });

  if (taskNormalizerEnabled) {
    const normalizerDuration = Date.now() - taskNormalizerStart;
    if (taskIntent.ok && taskIntent.source === 'llm') {
      const hintCount = taskIntent.search_hints.length;
      emitProgress({
        phase: 'task_normalizer_completed',
        status: 'completed',
        label: 'Task Normalizer',
        message: 'Task normalized into English search hints.',
        detail: `${taskIntent.original_language} → English, ${hintCount} search hint${hintCount === 1 ? '' : 's'}`,
        duration_ms: normalizerDuration,
      });
    } else if (taskIntent.source === 'fallback') {
      emitProgress({
        phase: 'task_normalizer_fallback',
        status: 'warning',
        label: 'Task Normalizer',
        message: 'Task Normalizer failed; continuing without normalized hints.',
        detail: taskIntent.warnings[0],
        duration_ms: normalizerDuration,
      });
    }
  }

  return { taskNormalizerEnabled, taskIntent };
}

async function runScanAndBootstrapProgressLog(
  opts: PromptPipelineOptions,
  taskIntent: TaskIntent,
  progress: PipelineProgressController,
): Promise<ScanBootstrapResult> {
  const { emitProgress } = progress;
  emitProgress({
    phase: 'scan_started',
    status: 'started',
    label: 'Scan',
    message: 'Scanning repository context.',
  });

  const scanStart = Date.now();
  const scan = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot, taskIntent });
  const taskIntentArtifactPaths = writeTaskIntentArtifacts(scan.runDir, taskIntent);
  progress.bootstrapProgressLog(scan.runDir);

  emitProgress({
    phase: 'run_created',
    status: 'completed',
    label: 'Run',
    message: 'Prompt pipeline run created.',
    run_id: scan.run_id,
  });
  emitProgress({
    phase: 'run_directory_ready',
    status: 'completed',
    label: 'Run',
    message: 'Run directory ready.',
    run_id: scan.run_id,
    artifact_path: scan.runDir,
  });

  emitProgress({
    phase: 'scanner_config_written',
    status: 'completed',
    label: 'Scanner config',
    message: 'Scanner config written.',
    run_id: scan.run_id,
    artifact_path: path.join(scan.runDir, 'scanner_config.json'),
  });

  if (scan.status === 'ok') {
    const scanDuration = Date.now() - scanStart;
    emitProgress({
      phase: 'scan_completed',
      status: 'completed',
      label: 'Scan',
      message: 'Repository scan completed.',
      run_id: scan.run_id,
      duration_ms: scanDuration,
    });

    const exactTextSummary = readExactTextHitsSummary(scan.scanDir);
    if (exactTextSummary) {
      const detail = exactTextSummary.phrases === 0
        ? 'no exact phrases extracted'
        : `${exactTextSummary.phrases} phrase${exactTextSummary.phrases === 1 ? '' : 's'}, ${exactTextSummary.hits} hit${exactTextSummary.hits === 1 ? '' : 's'}`;
      emitProgress({
        phase: 'exact_text_scan_completed',
        status: 'completed',
        label: 'Exact text scan',
        message: 'Exact text scan completed.',
        detail,
        run_id: scan.run_id,
        artifact_path: path.join(scan.scanDir, 'exact_text_hits.json'),
      });
    }
  }

  return { scan, taskIntentArtifactPaths };
}

async function runCodeGraphStep(
  opts: PromptPipelineOptions,
  scan: SuccessfulScanPhaseResult,
  taskIntent: TaskIntent,
  emitProgress: PipelineProgressController['emitProgress'],
): Promise<CodeGraphStepResult> {
  const flashDir = path.join(scan.runDir, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });

  const codegraphMode: CodeGraphContextMode = opts.codegraphMode ?? 'detect-only';
  const codegraphTransport: CodeGraphTransport = opts.codegraphTransport ?? DEFAULT_CODEGRAPH_TRANSPORT;
  const codegraphTask = buildCodeGraphTask(opts.task, taskIntent);
  if (codegraphMode === 'detect-only') {
    emitProgress({
      phase: 'codegraph_detect_started',
      status: 'started',
      label: 'CodeGraph',
      message: 'Detecting CodeGraph (detect-only).',
      detail: `transport requested: ${codeGraphTransportLabel(codegraphTransport)} (not used in detect-only)`,
      run_id: scan.run_id,
    });
  } else {
    emitProgress({
      phase: 'codegraph_use_existing_started',
      status: 'started',
      label: 'CodeGraph',
      message: 'Building CodeGraph context from existing index.',
      detail: `transport: ${codeGraphTransportLabel(codegraphTransport)}`,
      run_id: scan.run_id,
    });
  }

  const codegraphStart = Date.now();
  const codegraphResult = await buildCodeGraphContext({
    repoRoot: opts.repoRoot,
    task: codegraphTask,
    mode: codegraphMode,
    transport: codegraphTransport,
    ...(opts.codegraphMcpRunner ? { mcpRunner: opts.codegraphMcpRunner } : {}),
  });
  const codegraphArtifacts = writeCodeGraphContextArtifacts({ runDir: scan.runDir, result: codegraphResult });
  augmentExternalToolsWithCodeGraphContext(scan.scanDir, codegraphResult);
  const codegraphDuration = Date.now() - codegraphStart;
  const transportUsedDisplay = codegraphResult.transportUsed === 'mcp'
    ? 'MCP'
    : codegraphResult.transportUsed === 'cli'
      ? (codegraphResult.fallbackUsed ? 'CLI fallback' : 'CLI')
      : 'none';

  if (codegraphMode === 'detect-only') {
    emitProgress({
      phase: 'codegraph_detect_completed',
      status: 'completed',
      label: 'CodeGraph',
      message: 'CodeGraph detection completed.',
      detail: codegraphResult.reason
        ? `${codegraphResult.reason} — not used for context — transport requested: ${codeGraphTransportLabel(codegraphTransport)}`
        : `available, not used for context — transport requested: ${codeGraphTransportLabel(codegraphTransport)}`,
      run_id: scan.run_id,
      duration_ms: codegraphDuration,
    });
    emitProgress({
      phase: 'codegraph_detect_only',
      status: 'skipped',
      label: 'CodeGraph',
      message: 'CodeGraph detect-only — context not used.',
      run_id: scan.run_id,
    });
  } else if (codegraphResult.ok && codegraphResult.used) {
    if (codegraphResult.fallbackUsed) {
      emitProgress({
        phase: 'codegraph_transport_fallback',
        status: 'warning',
        label: 'CodeGraph',
        message: 'MCP context failed; falling back to CLI.',
        detail: codegraphResult.fallbackReason ?? 'MCP failure — switched to CLI transport',
        run_id: scan.run_id,
      });
    }
    emitProgress({
      phase: 'codegraph_context_completed',
      status: 'completed',
      label: 'CodeGraph',
      message: 'CodeGraph context attached.',
      detail: `${codegraphResult.reason ?? 'existing index'} — transport: ${transportUsedDisplay}`,
      run_id: scan.run_id,
      duration_ms: codegraphDuration,
      ...(codegraphArtifacts.contextArtifact ? { artifact_path: codegraphArtifacts.contextArtifact } : {}),
    });
  } else {
    if (codegraphResult.fallbackUsed) {
      emitProgress({
        phase: 'codegraph_transport_fallback',
        status: 'warning',
        label: 'CodeGraph',
        message: 'MCP context failed; falling back to CLI.',
        detail: codegraphResult.fallbackReason ?? 'MCP failure — switched to CLI transport',
        run_id: scan.run_id,
      });
    }
    emitProgress({
      phase: 'codegraph_context_failed',
      status: 'warning',
      label: 'CodeGraph',
      message: 'CodeGraph context unavailable; continuing without it.',
      detail: `${codegraphResult.error?.message ?? codegraphResult.reason ?? codegraphResult.warnings[0] ?? 'unknown'} — transport requested: ${codeGraphTransportLabel(codegraphTransport)}`,
      run_id: scan.run_id,
      duration_ms: codegraphDuration,
    });
  }

  return { flashDir, codegraphResult, codegraphArtifacts };
}

function buildFlashInputStep(
  opts: PromptPipelineOptions,
  scan: SuccessfulScanPhaseResult,
  flashDir: string,
  taskIntent: TaskIntent,
  warningCollector: PipelineWarningCollector,
  emitProgress: PipelineProgressController['emitProgress'],
  artifacts: string[],
): FlashInputStepResult {
  emitProgress({
    phase: 'flash_input_started',
    status: 'started',
    label: 'Flash input',
    message: 'Building flash input artifact.',
    run_id: scan.run_id,
  });
  const flashInputStart = Date.now();
  const flashManifest = buildFlashInputManifest({
    run_id: scan.run_id,
    task: opts.task,
    repo_root: opts.repoRoot,
    runDir: scan.runDir,
  });
  const previousRunSummary = formatPreviousRunSummary(
    getPreviousRunSummary({
      vibecodePath: scan.vibecodePath,
      currentRunId: scan.run_id,
    }),
  );
  const compactResult = buildCompactFlashContext({
    run_id: scan.run_id,
    task: opts.task,
    repo_root: opts.repoRoot,
    runDir: scan.runDir,
    previousRunSummary,
    taskIntent,
  });
  const { paths: compactPaths, budget: compactBudget } = compactResult;
  const flashManifestPath = path.join(flashDir, 'flash_input_manifest.json');
  const flashInputPath = path.join(flashDir, 'flash_input.md');
  const repoAtlasPath = compactPaths.repo_atlas_path ?? compactPaths.run_repo_atlas_path;
  const taskSlicePath = compactPaths.task_slice_path;
  const relevanceSelectionPath = compactPaths.relevance_selection_path;
  const flashInputBudgetPath = compactPaths.flash_input_budget_path;

  fs.writeFileSync(flashManifestPath, `${JSON.stringify(flashManifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(flashInputPath, compactResult.flashInput, 'utf8');
  artifacts.push(
    flashManifestPath,
    flashInputPath,
    repoAtlasPath,
    taskSlicePath,
    relevanceSelectionPath,
    flashInputBudgetPath,
  );
  if (compactPaths.repo_atlas_path) {
    artifacts.push(compactPaths.repo_atlas_path);
  }
  warningCollector.addWarnings('Flash input', flashManifest.warnings);

  const resolvedSystemPrompt = resolveFlashSystemPrompt({
    repoRoot: opts.repoRoot,
    bundledPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
    env: process.env,
  });
  warningCollector.addWarnings('Flash system prompt', resolvedSystemPrompt.warnings);

  emitProgress({
    phase: 'flash_input_built',
    status: 'completed',
    label: 'Flash input',
    message: 'Flash input artifact built.',
    detail: typeof compactBudget.estimated_tokens === 'number'
      ? `${compactBudget.estimated_tokens} estimated tokens`
      : undefined,
    run_id: scan.run_id,
    artifact_path: flashInputPath,
    duration_ms: Date.now() - flashInputStart,
  });

  return {
    compactResult,
    compactBudget,
    flashInputPath,
    repoAtlasPath,
    taskSlicePath,
    relevanceSelectionPath,
    flashInputBudgetPath,
    resolvedSystemPrompt,
  };
}

async function executeFlashStep(
  opts: PromptPipelineOptions,
  scan: SuccessfulScanPhaseResult,
  flashDir: string,
  adapter: LlmAdapter,
  resolved: ReturnType<typeof resolveFlashConfig>,
  configResolutionPath: string,
  resolvedSystemPrompt: ReturnType<typeof resolveFlashSystemPrompt>,
  flashInputMd: string,
  emitProgress: PipelineProgressController['emitProgress'],
  artifacts: string[],
): Promise<void> {
  emitProgress({
    phase: 'provider_resolved',
    status: 'completed',
    label: 'Provider',
    message: opts.mock ? 'Mock flash adapter ready.' : 'Flash provider resolved.',
    detail: opts.mock
      ? 'mock'
      : [resolved.resolution.provider, resolved.resolution.model].filter(Boolean).join(' / ') || undefined,
    run_id: scan.run_id,
    provider_id: opts.mock ? 'mock' : resolved.resolution.provider ?? undefined,
    model_id: opts.mock ? undefined : resolved.resolution.model ?? undefined,
  });
  emitProgress({
    phase: 'flash_request_started',
    status: 'started',
    label: 'Flash request',
    message: 'Flash request started.',
    run_id: scan.run_id,
  });

  const flashRequestStart = Date.now();
  const adapterResult = await adapter.run({
    flashInputMd,
    systemPrompt: resolvedSystemPrompt.content,
    flashDir,
    runId: scan.run_id,
    workspaceRoot: opts.repoRoot,
  });
  const flashRequestDuration = Date.now() - flashRequestStart;
  markFlashInputProviderCalled(scan.runDir, true);

  emitProgress({
    phase: 'flash_request_completed',
    status: 'completed',
    label: 'Flash request',
    message: 'Flash response received.',
    run_id: scan.run_id,
    duration_ms: flashRequestDuration,
  });
  emitProgress({
    phase: 'flash_response_received',
    status: 'completed',
    label: 'Flash request',
    message: 'Flash response received.',
    run_id: scan.run_id,
  });

  const flashSystemPromptArtifacts = writeFlashSystemPromptArtifacts(flashDir, resolvedSystemPrompt);
  const adapterMeta = adapterResult.meta as Record<string, unknown>;
  enrichFlashOutputMeta(flashDir, {
    provider: (typeof adapterMeta.provider === 'string' ? adapterMeta.provider : resolved.resolution.provider) ?? null,
    provider_label: resolved.resolution.provider_label,
    model: (typeof adapterMeta.model === 'string' ? adapterMeta.model : resolved.resolution.model) ?? null,
    model_label: resolved.resolution.model_label,
    live: typeof adapterMeta.live === 'boolean' ? adapterMeta.live : false,
    baseUrl_host: (typeof adapterMeta.baseUrl_host === 'string' ? adapterMeta.baseUrl_host : resolved.resolution.baseUrl_host) ?? null,
    config_source: resolved.resolution.selected_config_source,
    config_resolution_path: configResolutionPath,
  });

  emitProgress({
    phase: 'flash_output_parsed',
    status: 'completed',
    label: 'Flash output',
    message: 'Flash output parsed.',
    run_id: scan.run_id,
    artifact_path: path.join(flashDir, 'flash_output.md'),
  });
  emitProgress({
    phase: 'flash_output_meta_written',
    status: 'completed',
    label: 'Flash output',
    message: 'Flash output meta written.',
    run_id: scan.run_id,
    artifact_path: path.join(flashDir, 'flash_output_meta.json'),
  });
  emitProgress({
    phase: 'flash_output_validated',
    status: 'completed',
    label: 'Flash output',
    message: 'Flash output validated.',
    run_id: scan.run_id,
  });
  artifacts.push(
    flashSystemPromptArtifacts.promptPath,
    flashSystemPromptArtifacts.metaPath,
    path.join(flashDir, 'flash_output.md'),
    path.join(flashDir, 'flash_output_meta.json'),
    path.join(flashDir, 'tool_calls.json'),
  );
}

async function finalizeAndRenderStep(args: {
  scan: SuccessfulScanPhaseResult;
  taskIntentArtifactPaths: TaskIntentArtifactPaths;
  taskNormalizerEnabled: boolean;
  taskIntent: TaskIntent;
  compactBudget: ReturnType<typeof buildCompactFlashContext>['budget'];
  flashInputPath: string;
  repoAtlasPath: string;
  taskSlicePath: string;
  relevanceSelectionPath: string;
  flashInputBudgetPath: string;
  artifacts: string[];
  warningCollector: PipelineWarningCollector;
  progress: PipelineProgressController;
}): Promise<PromptPipelineResult> {
  const {
    scan,
    taskIntentArtifactPaths,
    taskNormalizerEnabled,
    taskIntent,
    compactBudget,
    flashInputPath,
    repoAtlasPath,
    taskSlicePath,
    relevanceSelectionPath,
    flashInputBudgetPath,
    artifacts,
    warningCollector,
    progress,
  } = args;
  const { emitProgress } = progress;

  const contextResult = finalizeContext(scan.runDir);
  artifacts.push(...contextResult.artifacts);
  warningCollector.addWarnings('Context', contextResult.warnings);
  emitProgress({
    phase: 'context_pack_written',
    status: 'completed',
    label: 'Context pack',
    message: 'Context pack written.',
    run_id: scan.run_id,
    artifact_path: path.join(scan.runDir, 'output', 'context_pack.md'),
  });

  const doneManifest: RunManifest = {
    ...scan.manifest,
    status: 'done',
  };
  writeRunManifest(scan.runManifestPath, doneManifest);

  const renderResult = renderFinalPrompt(scan.runDir, { vibecodePath: scan.vibecodePath });
  if (!renderResult.ok) {
    const result: PromptPipelineError = {
      ok: false,
      error: renderResult.error ?? {
        code: 'PROMPT_RENDER_FAILED',
        message: 'prompt render failed',
        path: path.join(scan.runDir, 'output', 'final_prompt.md'),
        details: [],
      },
    };
    emitProgress({
      phase: 'pipeline_failed',
      status: 'failed',
      label: 'Final prompt',
      message: `${result.error.code}: ${result.error.message}`,
      run_id: scan.run_id,
    });
    emitProgress({
      phase: 'failed',
      status: 'failed',
      label: 'Final prompt',
      message: `${result.error.code}: ${result.error.message}`,
      run_id: scan.run_id,
    });
    return result;
  }

  await updateCurrent(scan.vibecodePath, doneManifest);

  const finalPromptPath = path.join(scan.runDir, 'output', 'final_prompt.md');
  artifacts.push(...(renderResult.artifacts ?? [finalPromptPath]));
  warningCollector.addWarnings('Final prompt', renderResult.warnings);
  emitProgress({
    phase: 'final_prompt_rendered',
    status: 'completed',
    label: 'Final prompt',
    message: 'Final prompt rendered.',
    run_id: scan.run_id,
    artifact_path: finalPromptPath,
  });
  emitProgress({
    phase: 'final_prompt_written',
    status: 'completed',
    label: 'Final prompt',
    message: 'Final prompt written.',
    run_id: scan.run_id,
    artifact_path: finalPromptPath,
  });

  if (warningCollector.warnings.length > 0) {
    for (const entry of warningCollector.warningDetails) {
      emitProgress({
        phase: 'pipeline_warning',
        status: 'warning',
        label: entry.label,
        message: entry.message,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        ...(entry.artifact_path !== undefined ? { artifact_path: entry.artifact_path } : {}),
        run_id: scan.run_id,
      });
    }
    emitProgress({
      phase: 'pipeline_completed_with_warnings',
      status: 'warning',
      label: 'Run',
      message: `Pipeline completed with ${warningCollector.warnings.length} warning${warningCollector.warnings.length === 1 ? '' : 's'}.`,
      run_id: scan.run_id,
    });
  }
  emitProgress({
    phase: 'run_completed',
    status: 'completed',
    label: 'Run',
    message: 'Run completed.',
    run_id: scan.run_id,
    duration_ms: progress.getElapsedMs(),
  });

  return {
    ok: true,
    run_id: scan.run_id,
    runDir: scan.runDir,
    finalPromptPath,
    flashInputPath,
    repoAtlasPath,
    taskSlicePath,
    relevanceSelectionPath,
    flashInputBudgetPath,
    taskIntentPath: taskIntentArtifactPaths.jsonPath,
    taskNormalizerEnabled,
    taskNormalizerOk: taskIntent.ok,
    taskNormalizerLanguage: taskIntent.original_language,
    estimatedTokens: compactBudget.estimated_tokens,
    hardMaxTokens: compactBudget.hard_max_tokens,
    providerCalled: true,
    artifacts: unique(artifacts),
    warnings: warningCollector.warnings,
    ...(progress.getProgressEventsPath() ? { progressEventsPath: progress.getProgressEventsPath() } : {}),
  };
}

export async function runPromptPipeline(opts: PromptPipelineOptions): Promise<PromptPipelineResult> {
  const progress = createProgressEmitter(opts);
  const { emitProgress, redactSecrets } = progress;

  if (opts.mock && opts.live) {
    const result = errorResult(
      'FLASH_MODE_CONFLICT',
      '--mock and --live cannot be used together. Use one or the other.',
      '',
      ['--mock uses the deterministic mock adapter.', '--live calls the configured flash provider.'],
    );
    emitProgress({
      phase: 'pipeline_failed',
      status: 'failed',
      label: 'Pipeline',
      message: `${result.error.code}: ${result.error.message}`,
    });
    emitProgress({
      phase: 'failed',
      status: 'failed',
      label: 'Pipeline',
      message: `${result.error.code}: ${result.error.message}`,
    });
    return result;
  }
  if (!opts.mock && !opts.live && !opts.adapter) {
    const result = errorResult(
      'FLASH_MODE_REQUIRED',
      'Flash mode is required. Use --mock for deterministic prompt generation or --live for configured flash model calls.',
      '',
      ['--mock: deterministic, no provider call.', '--live: calls the configured flash provider.'],
    );
    emitProgress({
      phase: 'pipeline_failed',
      status: 'failed',
      label: 'Pipeline',
      message: `${result.error.code}: ${result.error.message}`,
    });
    emitProgress({
      phase: 'failed',
      status: 'failed',
      label: 'Pipeline',
      message: `${result.error.code}: ${result.error.message}`,
    });
    return result;
  }

  const ensured = ensureLocalConfig({ repoRoot: opts.repoRoot, env: process.env });
  const resolved = resolveFlashConfig({
    repoRoot: opts.repoRoot,
    env: process.env,
    live: opts.live,
    mock: opts.mock,
    localCreatedFromGlobal: ensured.createdFromGlobal,
    cliFlags: { provider: opts.flashProvider, model: opts.flashModel },
  });

  let adapter: LlmAdapter;
  if (opts.mock) {
    adapter = new MockFlashAdapter();
  } else if (opts.adapter) {
    adapter = opts.adapter;
  } else {
    if (!resolved.providerConfig) {
      const code = resolved.error?.code ?? 'FLASH_PROVIDER_NOT_CONFIGURED';
      const message = code === 'FLASH_PROVIDER_NOT_CONFIGURED'
        ? 'No flash provider configured. Use --mock for deterministic local runs or pass --live with provider configuration.'
        : resolved.error?.message ?? 'flash provider configuration is incomplete';
      const result = errorResult(code, message, '', resolved.error?.details ?? []);
      emitProgress({
        phase: 'pipeline_failed',
        status: 'failed',
        label: 'Provider',
        message: `${result.error.code}: ${result.error.message}`,
      });
      emitProgress({
        phase: 'failed',
        status: 'failed',
        label: 'Provider',
        message: `${result.error.code}: ${result.error.message}`,
      });
      return result;
    }
    adapter = new OpenAiCompatibleAdapter(resolved.providerConfig);
  }

  const { taskNormalizerEnabled, taskIntent } = await runTaskNormalizerStep(opts, resolved, emitProgress);
  const { scan, taskIntentArtifactPaths } = await runScanAndBootstrapProgressLog(opts, taskIntent, progress);

  if (scan.status === 'error') {
    const result = errorResult('SCANNER_FAILED', scan.diagnostic, scan.scanDir, []);
    emitProgress({
      phase: 'pipeline_failed',
      status: 'failed',
      label: 'Scan',
      message: `${result.error.code}: ${result.error.message}`,
      run_id: scan.run_id,
    });
    emitProgress({
      phase: 'failed',
      status: 'failed',
      label: 'Scan',
      message: `${result.error.code}: ${result.error.message}`,
      run_id: scan.run_id,
    });
    return result;
  }

  const { flashDir, codegraphResult, codegraphArtifacts } = await runCodeGraphStep(opts, scan, taskIntent, emitProgress);
  const configResolutionPath = writeConfigResolution(scan.runDir, resolved.resolution);

  const artifacts: string[] = [
    path.join(scan.runDir, 'user_prompt.md'),
    scan.runManifestPath,
    path.join(scan.runDir, 'scanner_config.json'),
    configResolutionPath,
    taskIntentArtifactPaths.jsonPath,
    taskIntentArtifactPaths.mdPath,
    path.join(scan.scanDir, 'scan_manifest.json'),
    path.join(scan.runDir, 'skills', 'skills_catalog.json'),
    codegraphArtifacts.usageArtifact,
    ...(codegraphArtifacts.contextArtifact ? [codegraphArtifacts.contextArtifact] : []),
    ...(codegraphArtifacts.repoAtlasArtifact ? [codegraphArtifacts.repoAtlasArtifact] : []),
    ...(codegraphArtifacts.repoAtlasJsonArtifact ? [codegraphArtifacts.repoAtlasJsonArtifact] : []),
    ...Object.values(scan.artifacts),
  ];
  const warningCollector = createWarningCollector();
  warningCollector.addWarnings('Scanner', scan.warnings);
  warningCollector.addWarnings('Provider', resolved.resolution.warnings);
  warningCollector.addWarnings('CodeGraph', codegraphResult.warnings);
  if (!taskIntent.ok && taskIntent.source === 'fallback') {
    warningCollector.addWarnings('Task Normalizer', taskIntent.warnings);
  }

  try {
    const {
      compactResult,
      compactBudget,
      flashInputPath,
      repoAtlasPath,
      taskSlicePath,
      relevanceSelectionPath,
      flashInputBudgetPath,
      resolvedSystemPrompt,
    } = buildFlashInputStep(opts, scan, flashDir, taskIntent, warningCollector, emitProgress, artifacts);

    await executeFlashStep(
      opts,
      scan,
      flashDir,
      adapter,
      resolved,
      configResolutionPath,
      resolvedSystemPrompt,
      compactResult.flashInput,
      emitProgress,
      artifacts,
    );

    return await finalizeAndRenderStep({
      scan,
      taskIntentArtifactPaths,
      taskNormalizerEnabled,
      taskIntent,
      compactBudget,
      flashInputPath,
      repoAtlasPath,
      taskSlicePath,
      relevanceSelectionPath,
      flashInputBudgetPath,
      artifacts,
      warningCollector,
      progress,
    });
  } catch (error) {
    const diagnostic = contextFinalizeErrorToDiagnostic(error, scan.runDir);
    const errorArtifacts: string[] = [];
    if (error instanceof LlmAdapterError && error.code === 'FLASH_PROVIDER_BAD_RESPONSE') {
      const providerErrorPath = path.join(flashDir, 'provider_error.json');
      if (fs.existsSync(providerErrorPath)) errorArtifacts.push(providerErrorPath);
    }
    if (error instanceof LlmAdapterError) {
      emitProgress({
        phase: 'flash_request_failed',
        status: 'failed',
        label: 'Flash request',
        message: redactSecrets(`${diagnostic.code}: ${diagnostic.message}`, [resolved.providerConfig?.apiKey]),
        run_id: scan.run_id,
      });
    }
    emitProgress({
      phase: 'pipeline_failed',
      status: 'failed',
      label: 'Pipeline',
      message: redactSecrets(`${diagnostic.code}: ${diagnostic.message}`, [resolved.providerConfig?.apiKey]),
      run_id: scan.run_id,
    });
    emitProgress({
      phase: 'failed',
      status: 'failed',
      label: 'Pipeline',
      message: redactSecrets(`${diagnostic.code}: ${diagnostic.message}`, [resolved.providerConfig?.apiKey]),
      run_id: scan.run_id,
    });
    return {
      ok: false,
      error: {
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
        details: diagnostic.details,
        ...(errorArtifacts.length > 0 ? { artifacts: errorArtifacts } : {}),
      },
    };
  }
}
