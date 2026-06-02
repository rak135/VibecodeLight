import fs from 'fs';
import path from 'path';

import { LlmAdapterError, ProviderNotConfiguredError } from '../../adapters/llm/errors.js';
import { MockFlashAdapter } from '../../adapters/llm/mock_flash.js';
import { OpenAiCompatibleAdapter } from '../../adapters/llm/openai_compatible_adapter.js';
import { resolveFlashConfig, writeConfigResolution } from '../config/index.js';
import { enrichFlashOutputMeta } from '../context/index.js';
import { resolveFlashSystemPrompt, writeFlashSystemPromptArtifacts } from '../prompts/flash_system_prompt.js';

export interface FlashPhaseOptions {
  runId: string;
  runDir: string;
  repoRoot: string;
  mock?: boolean;
  live?: boolean;
  flashProvider?: string;
  flashModel?: string;
  bundledFlashSystemPromptPath: string;
}

export interface FlashPhaseResult {
  status: 'ok' | 'error';
  run_id?: string;
  runDir?: string;
  flashDir?: string;
  artifacts?: string[];
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

function toFlashPhaseErrorEnvelope(error: unknown, fallbackPath?: string): NonNullable<FlashPhaseResult['error']> {
  if (error instanceof LlmAdapterError) {
    return {
      code: error.code,
      message: error.message,
      path: error.path ?? fallbackPath,
      details: error.details,
    };
  }

  return {
    code: 'FLASH_RUN_FAILED',
    message: error instanceof Error ? error.message : String(error),
    path: fallbackPath,
    details: [],
  };
}

export async function performFlashPhase(opts: FlashPhaseOptions): Promise<FlashPhaseResult> {
  const { runId, runDir } = opts;
  const flashDir = path.join(runDir, 'flash');

  try {
    const flashInputPath = path.join(flashDir, 'flash_input.md');

    if (!fs.existsSync(runDir)) {
      throw new LlmAdapterError(`run not found: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        path: runDir,
        details: [],
      });
    }

    if (!fs.existsSync(flashInputPath)) {
      throw new LlmAdapterError(`missing flash_input.md for run ${runId}`, {
        code: 'FLASH_INPUT_NOT_FOUND',
        path: flashInputPath,
        details: ['Run context-build before flash run, or choose a run containing flash/flash_input.md.'],
      });
    }

    const flashInputMd = fs.readFileSync(flashInputPath, 'utf8');
    const resolvedSystemPrompt = resolveFlashSystemPrompt({
      repoRoot: opts.repoRoot,
      bundledPromptPath: opts.bundledFlashSystemPromptPath,
      env: process.env,
    });

    const resolved = resolveFlashConfig({
      repoRoot: opts.repoRoot,
      env: process.env,
      live: opts.live,
      mock: opts.mock,
      cliFlags: { provider: opts.flashProvider, model: opts.flashModel },
    });

    let adapterResult;
    if (!opts.mock) {
      if (!resolved.providerConfig) {
        throw new ProviderNotConfiguredError('no flash provider configured; set provider config in the local/global config or AppData .env, or use --mock', {
          path: flashInputPath,
          details: resolved.error?.details ?? [],
        });
      }

      if (!opts.live) {
        throw new LlmAdapterError(
          'live model calls are disabled in normal flash run; use --mock for tests/smoke or pass --live with provider configuration',
          { code: 'LIVE_PROVIDER_DISABLED', path: flashInputPath, details: ['Default flash run does not call real providers.'] },
        );
      }

      const liveAdapter = new OpenAiCompatibleAdapter(resolved.providerConfig);
      adapterResult = await liveAdapter.run({
        flashInputMd,
        systemPrompt: resolvedSystemPrompt.content,
        flashDir,
        runId,
        workspaceRoot: opts.repoRoot,
      });
    } else {
      const adapter = new MockFlashAdapter();
      adapterResult = await adapter.run({
        flashInputMd,
        systemPrompt: resolvedSystemPrompt.content,
        flashDir,
        runId,
        workspaceRoot: opts.repoRoot,
      });
    }

    const flashSystemPromptArtifacts = writeFlashSystemPromptArtifacts(flashDir, resolvedSystemPrompt);
    const configResolutionPath = writeConfigResolution(runDir, resolved.resolution);
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

    const artifacts = [
      flashSystemPromptArtifacts.promptPath,
      flashSystemPromptArtifacts.metaPath,
      path.join(flashDir, 'flash_output.md'),
      path.join(flashDir, 'flash_output_meta.json'),
      path.join(flashDir, 'tool_calls.json'),
    ];

    return {
      status: 'ok',
      run_id: runId,
      runDir,
      flashDir,
      artifacts,
      warnings: [...resolved.resolution.warnings, ...resolvedSystemPrompt.warnings],
    };
  } catch (error) {
    return {
      status: 'error',
      run_id: runId,
      runDir,
      flashDir,
      error: toFlashPhaseErrorEnvelope(error, runDir),
    };
  }
}
