import path from 'path';

import type { FlashAdapterResult, LlmAdapter } from '../../adapters/llm/base.js';
import { enrichFlashOutputMeta } from '../context/index.js';
import {
  writeFlashSystemPromptArtifacts,
  type FlashSystemPromptArtifacts,
  type ResolvedFlashSystemPrompt,
} from '../prompts/flash_system_prompt.js';

export interface SharedFlashExecutionMeta {
  provider: string | null | undefined;
  provider_label: string | null;
  model: string | null | undefined;
  model_label: string | null;
  baseUrl_host: string | null | undefined;
  config_source: string | null;
}

export interface ExecuteFlashRequestAndWriteArtifactsOptions {
  adapter: LlmAdapter;
  flashInputMd: string;
  resolvedSystemPrompt: ResolvedFlashSystemPrompt;
  flashDir: string;
  runId: string;
  workspaceRoot: string;
  meta: SharedFlashExecutionMeta;
  resolveConfigResolutionPath: () => string;
  afterAdapterRun?: (_adapterResult: FlashAdapterResult) => void;
}

export interface ExecuteFlashRequestAndWriteArtifactsResult {
  adapterResult: FlashAdapterResult;
  flashSystemPromptArtifacts: FlashSystemPromptArtifacts;
  artifacts: string[];
}

export async function executeFlashRequestAndWriteArtifacts(
  opts: ExecuteFlashRequestAndWriteArtifactsOptions,
): Promise<ExecuteFlashRequestAndWriteArtifactsResult> {
  const adapterResult = await opts.adapter.run({
    flashInputMd: opts.flashInputMd,
    systemPrompt: opts.resolvedSystemPrompt.content,
    flashDir: opts.flashDir,
    runId: opts.runId,
    workspaceRoot: opts.workspaceRoot,
  });
  opts.afterAdapterRun?.(adapterResult);

  const flashSystemPromptArtifacts = writeFlashSystemPromptArtifacts(opts.flashDir, opts.resolvedSystemPrompt);
  const configResolutionPath = opts.resolveConfigResolutionPath();
  const adapterMeta = adapterResult.meta as Record<string, unknown>;
  enrichFlashOutputMeta(opts.flashDir, {
    provider: (typeof adapterMeta.provider === 'string' ? adapterMeta.provider : opts.meta.provider) ?? null,
    provider_label: opts.meta.provider_label,
    model: (typeof adapterMeta.model === 'string' ? adapterMeta.model : opts.meta.model) ?? null,
    model_label: opts.meta.model_label,
    live: typeof adapterMeta.live === 'boolean' ? adapterMeta.live : false,
    baseUrl_host: (typeof adapterMeta.baseUrl_host === 'string' ? adapterMeta.baseUrl_host : opts.meta.baseUrl_host) ?? null,
    config_source: opts.meta.config_source,
    config_resolution_path: configResolutionPath,
  });

  return {
    adapterResult,
    flashSystemPromptArtifacts,
    artifacts: [
      flashSystemPromptArtifacts.promptPath,
      flashSystemPromptArtifacts.metaPath,
      path.join(opts.flashDir, 'flash_output.md'),
      path.join(opts.flashDir, 'flash_output_meta.json'),
      path.join(opts.flashDir, 'tool_calls.json'),
    ],
  };
}
