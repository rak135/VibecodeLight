import fs from 'fs';
import path from 'path';

import type { LlmAdapter } from '../../adapters/llm/base.js';
import { MockFlashAdapter } from '../../adapters/llm/mock_flash.js';
import { OpenAiCompatibleAdapter } from '../../adapters/llm/openai_compatible_adapter.js';
import {
  ensureLocalConfig,
  resolveFlashConfig,
  writeConfigResolution,
} from '../config/index.js';
import { buildFlashInput,
  buildFlashInputManifest,
  contextFinalizeErrorToDiagnostic,
  enrichFlashOutputMeta,
  finalizeContext,
  formatPreviousRunSummary,
  getPreviousRunSummary,
} from '../context/index.js';
import { renderFinalPrompt } from './renderer.js';
import { updateCurrent } from '../runs/current.js';
import { performScanPhase, writeRunManifest } from '../runs/scan_phase.js';
import type { RunManifest } from '../models/index.js';

export interface PromptPipelineOptions {
  task: string;
  repoRoot: string;
  mock: boolean;
  live?: boolean;
  adapter?: LlmAdapter;
}

export interface PromptPipelineSuccess {
  ok: true;
  run_id: string;
  runDir: string;
  finalPromptPath: string;
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
  };
}

export type PromptPipelineResult = PromptPipelineSuccess | PromptPipelineError;

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
  // Ensure a local workspace config exists (snapshot from global, or minimal
  // defaults) so resolution and the config artifact are meaningful per run.
  const ensured = ensureLocalConfig({ repoRoot: opts.repoRoot, env: process.env });
  const resolved = resolveFlashConfig({
    repoRoot: opts.repoRoot,
    env: process.env,
    live: opts.live,
    mock: opts.mock,
    localCreatedFromGlobal: ensured.createdFromGlobal,
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
      return errorResult(code, message, '', resolved.error?.details ?? []);
    }
    adapter = new OpenAiCompatibleAdapter(resolved.providerConfig);
  }

  const scan = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot });
  if (scan.status === 'error') {
    return errorResult('SCANNER_FAILED', scan.diagnostic, scan.scanDir, []);
  }

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
    const flashInput = buildFlashInput({
      run_id: scan.run_id,
      task: opts.task,
      repo_root: opts.repoRoot,
      runDir: scan.runDir,
      previousRunSummary,
      manifest: flashManifest,
    });
    const flashManifestPath = path.join(flashDir, 'flash_input_manifest.json');
    const flashInputPath = path.join(flashDir, 'flash_input.md');
    fs.writeFileSync(flashManifestPath, `${JSON.stringify(flashManifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(flashInputPath, flashInput, 'utf8');
    artifacts.push(flashManifestPath, flashInputPath);
    warnings.push(...flashManifest.warnings);

    const adapter2 = adapter;
    const adapterResult = await adapter2.run({ flashInputMd: flashInput, runId: scan.run_id, workspaceRoot: opts.repoRoot });
    const adapterMeta = adapterResult.meta as Record<string, unknown>;
    enrichFlashOutputMeta(flashDir, {
      provider: (typeof adapterMeta.provider === 'string' ? adapterMeta.provider : resolved.resolution.provider) ?? null,
      model: (typeof adapterMeta.model === 'string' ? adapterMeta.model : resolved.resolution.model) ?? null,
      live: typeof adapterMeta.live === 'boolean' ? adapterMeta.live : false,
      baseUrl_host: (typeof adapterMeta.baseUrl_host === 'string' ? adapterMeta.baseUrl_host : resolved.resolution.baseUrl_host) ?? null,
      config_source: resolved.resolution.selected_config_source,
      config_resolution_path: configResolutionPath,
    });
    artifacts.push(
      path.join(flashDir, 'flash_output.md'),
      path.join(flashDir, 'flash_output_meta.json'),
      path.join(flashDir, 'tool_calls.json'),
    );

    const contextResult = finalizeContext(scan.runDir);
    artifacts.push(...contextResult.artifacts);
    warnings.push(...contextResult.warnings);

    const doneManifest: RunManifest = {
      ...scan.manifest,
      status: 'done',
    };
    writeRunManifest(scan.runManifestPath, doneManifest);

    const renderResult = renderFinalPrompt(scan.runDir, { vibecodePath: scan.vibecodePath });
    if (!renderResult.ok) {
      return {
        ok: false,
        error: renderResult.error ?? {
          code: 'PROMPT_RENDER_FAILED',
          message: 'prompt render failed',
          path: path.join(scan.runDir, 'output', 'final_prompt.md'),
          details: [],
        },
      };
    }

    await updateCurrent(scan.vibecodePath, doneManifest);

    const finalPromptPath = path.join(scan.runDir, 'output', 'final_prompt.md');
    artifacts.push(...(renderResult.artifacts ?? [finalPromptPath]));
    warnings.push(...(renderResult.warnings ?? []));

    return {
      ok: true,
      run_id: scan.run_id,
      runDir: scan.runDir,
      finalPromptPath,
      artifacts: unique(artifacts),
      warnings,
    };
  } catch (error) {
    const diagnostic = contextFinalizeErrorToDiagnostic(error, scan.runDir);
    return {
      ok: false,
      error: {
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
        details: diagnostic.details,
      },
    };
  }
}
