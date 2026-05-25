import fs from 'fs';
import path from 'path';

import type { LlmAdapter } from '../../adapters/llm/base.js';
import { LlmAdapterError } from '../../adapters/llm/errors.js';
import { MockFlashAdapter } from '../../adapters/llm/mock_flash.js';
import { OpenAiCompatibleAdapter } from '../../adapters/llm/openai_compatible_adapter.js';
import {
  ensureLocalConfig,
  resolveFlashConfig,
  writeConfigResolution,
} from '../config/index.js';
import { buildCompactFlashContext,
  buildFlashInputManifest,
  contextFinalizeErrorToDiagnostic,
  enrichFlashOutputMeta,
  finalizeContext,
  formatPreviousRunSummary,
  getPreviousRunSummary,
  markFlashInputProviderCalled,
} from '../context/index.js';
import { renderFinalPrompt } from './renderer.js';
import type { PipelineEvent } from './pipeline_events.js';
import type { PipelineProgressCallback } from './pipeline_events.js';
import { updateCurrent } from '../runs/current.js';
import { performScanPhase, writeRunManifest } from '../runs/scan_phase.js';
import type { RunManifest } from '../models/index.js';

export interface PromptPipelineOptions {
  task: string;
  repoRoot: string;
  mock: boolean;
  live?: boolean;
  adapter?: LlmAdapter;
  flashProvider?: string;
  flashModel?: string;
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
  estimatedTokens?: number;
  hardMaxTokens?: number;
  providerCalled?: boolean;
  artifacts: string[];
  warnings: string[];
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

type PipelineEventInput = Omit<PipelineEvent, 'elapsed_ms'> & { elapsed_ms?: number };

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

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

export async function runPromptPipeline(opts: PromptPipelineOptions): Promise<PromptPipelineResult> {
  const startTime = Date.now();
  const emitProgress = (event: PipelineEventInput): void => {
    opts.onProgress?.({
      ...event,
      elapsed_ms: event.elapsed_ms ?? Date.now() - startTime,
    });
  };

  const redactSecrets = (message: string, secrets: Array<string | undefined>): string => {
    let safeMessage = message;
    for (const secret of secrets) {
      if (secret) safeMessage = safeMessage.split(secret).join('[REDACTED]');
    }
    return safeMessage;
  };

  // Validate explicit mode flags: both together is a conflict, neither is required.
  if (opts.mock && opts.live) {
    const result = errorResult(
      'FLASH_MODE_CONFLICT',
      '--mock and --live cannot be used together. Use one or the other.',
      '',
      ['--mock uses the deterministic mock adapter.', '--live calls the configured flash provider.'],
    );
    emitProgress({ phase: 'failed', message: `${result.error.code}: ${result.error.message}` });
    return result;
  }
  if (!opts.mock && !opts.live && !opts.adapter) {
    const result = errorResult(
      'FLASH_MODE_REQUIRED',
      'Flash mode is required. Use --mock for deterministic prompt generation or --live for configured flash model calls.',
      '',
      ['--mock: deterministic, no provider call.', '--live: calls the configured flash provider.'],
    );
    emitProgress({ phase: 'failed', message: `${result.error.code}: ${result.error.message}` });
    return result;
  }

  // Ensure a local workspace config exists (snapshot from global, or minimal
  // defaults) so resolution and the config artifact are meaningful per run.
  const ensured = ensureLocalConfig({ repoRoot: opts.repoRoot, env: process.env });
  const resolved = resolveFlashConfig({
    repoRoot: opts.repoRoot,
    env: process.env,
    live: opts.live,
    mock: opts.mock,
    localCreatedFromGlobal: ensured.createdFromGlobal,
    cliFlags: { provider: opts.flashProvider, model: opts.flashModel },
  });

  // Resolve which adapter to use
  let adapter: LlmAdapter;
  if (opts.mock) {
    adapter = new MockFlashAdapter();
  } else if (opts.adapter) {
    adapter = opts.adapter;
  } else {
    // Live mode: require resolved provider config
    if (!resolved.providerConfig) {
      const code = resolved.error?.code ?? 'FLASH_PROVIDER_NOT_CONFIGURED';
      const message = code === 'FLASH_PROVIDER_NOT_CONFIGURED'
        ? 'No flash provider configured. Use --mock for deterministic local runs or pass --live with provider configuration.'
        : resolved.error?.message ?? 'flash provider configuration is incomplete';
      const result = errorResult(code, message, '', resolved.error?.details ?? []);
      emitProgress({ phase: 'failed', message: `${result.error.code}: ${result.error.message}` });
      return result;
    }
    adapter = new OpenAiCompatibleAdapter(resolved.providerConfig);
  }

  emitProgress({ phase: 'scan_started', message: 'Scanning repository context.' });
  const scan = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot });
  emitProgress({ phase: 'run_created', message: 'Prompt pipeline run created.', run_id: scan.run_id });
  if (scan.status === 'error') {
    const result = errorResult('SCANNER_FAILED', scan.diagnostic, scan.scanDir, []);
    emitProgress({ phase: 'failed', message: `${result.error.code}: ${result.error.message}`, run_id: scan.run_id });
    return result;
  }
  emitProgress({ phase: 'scan_completed', message: 'Repository scan completed.', run_id: scan.run_id });

  const flashDir = path.join(scan.runDir, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });

  // Safe (secret-free) record of how config was resolved for this run.
  const configResolutionPath = writeConfigResolution(scan.runDir, resolved.resolution);

  const artifacts: string[] = [
    path.join(scan.runDir, 'user_prompt.md'),
    scan.runManifestPath,
    path.join(scan.runDir, 'scanner_config.json'),
    configResolutionPath,
    path.join(scan.scanDir, 'scan_manifest.json'),
    path.join(scan.runDir, 'skills', 'skills_catalog.json'),
    ...Object.values(scan.artifacts),
  ];
  const warnings = [...scan.warnings, ...resolved.resolution.warnings];

  try {
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
    warnings.push(...flashManifest.warnings);
    emitProgress({
      phase: 'flash_input_built',
      message: 'Flash input artifact built.',
      run_id: scan.run_id,
      artifact_path: flashInputPath,
    });

    const adapter2 = adapter;
    emitProgress({
      phase: 'provider_resolved',
      message: 'Flash provider resolved.',
      run_id: scan.run_id,
      provider_id: opts.mock ? 'mock' : resolved.resolution.provider ?? undefined,
      model_id: opts.mock ? undefined : resolved.resolution.model ?? undefined,
    });
    emitProgress({
      phase: 'flash_request_started',
      message: 'Flash request started.',
      run_id: scan.run_id,
    });
    const adapterResult = await adapter2.run({
      flashInputMd: compactResult.flashInput,
      flashDir,
      runId: scan.run_id,
      workspaceRoot: opts.repoRoot,
    });
    markFlashInputProviderCalled(scan.runDir, true);
    emitProgress({
      phase: 'flash_response_received',
      message: 'Flash response received.',
      run_id: scan.run_id,
    });
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
      phase: 'flash_output_validated',
      message: 'Flash output validated.',
      run_id: scan.run_id,
    });
    artifacts.push(
      path.join(flashDir, 'flash_output.md'),
      path.join(flashDir, 'flash_output_meta.json'),
      path.join(flashDir, 'tool_calls.json'),
    );

    const contextResult = finalizeContext(scan.runDir);
    artifacts.push(...contextResult.artifacts);
    warnings.push(...contextResult.warnings);
    emitProgress({
      phase: 'context_pack_written',
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
      emitProgress({ phase: 'failed', message: `${result.error.code}: ${result.error.message}`, run_id: scan.run_id });
      return result;
    }

    await updateCurrent(scan.vibecodePath, doneManifest);

    const finalPromptPath = path.join(scan.runDir, 'output', 'final_prompt.md');
    artifacts.push(...(renderResult.artifacts ?? [finalPromptPath]));
    warnings.push(...(renderResult.warnings ?? []));
    emitProgress({
      phase: 'final_prompt_written',
      message: 'Final prompt written.',
      run_id: scan.run_id,
      artifact_path: finalPromptPath,
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
      estimatedTokens: compactBudget.estimated_tokens,
      hardMaxTokens: compactBudget.hard_max_tokens,
      providerCalled: true,
      artifacts: unique(artifacts),
      warnings,
    };
  } catch (error) {
    const diagnostic = contextFinalizeErrorToDiagnostic(error, scan.runDir);
    const errorArtifacts: string[] = [];
    if (error instanceof LlmAdapterError && error.code === 'FLASH_PROVIDER_BAD_RESPONSE') {
      const providerErrorPath = path.join(flashDir, 'provider_error.json');
      if (fs.existsSync(providerErrorPath)) errorArtifacts.push(providerErrorPath);
    }
    emitProgress({
      phase: 'failed',
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
