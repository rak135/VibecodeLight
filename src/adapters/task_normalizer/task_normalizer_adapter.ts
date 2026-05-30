import fs from 'fs';
import path from 'path';

import { OpenAiCompatibleAdapter } from '../llm/openai_compatible_adapter.js';
import type { ProviderConfig } from '../llm/provider_config.js';
import { parseTaskIntentJson } from './task_intent_parser.js';
import type { TaskIntent, TaskIntentEnabled } from './types.js';

export interface TaskNormalizerInput {
  task: string;
  enabled: boolean;
  // The caller passes the resolved flash provider/model config when task normalization
  // is explicitly enabled; no separate task-normalizer config is introduced in Group 1.
  providerConfig?: import('../../adapters/llm/provider_config.js').ProviderConfig;
  modelInfo?: { provider: string; model: string };
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface OpenAiCompatibleAdapterInternals {
  config: ProviderConfig;
  fetchFn: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'gpt-4o-mini';
const BUNDLED_TASK_NORMALIZER_SYSTEM_PROMPT_PATH = path.resolve(__dirname, '../../../resources/prompts/task_normalizer_system.md');
const CZECH_DIACRITICS_PATTERN = /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;

function buildDisabledIntent(task: string): TaskIntent {
  return {
    enabled: false,
    ok: true,
    source: 'disabled',
    original_task: task,
    original_language: 'unknown',
    normalized_english_task: '',
    search_hints: [],
    keyword_groups: {},
    negative_constraints: [],
    validation_hints: [],
    uncertainties: [],
    warnings: [],
  };
}

function buildFallbackIntent(task: string, warnings: string[], model?: { provider: string; model: string; live: boolean }): TaskIntent {
  return {
    enabled: true,
    ok: false,
    source: 'fallback',
    original_task: task,
    original_language: 'unknown',
    normalized_english_task: '',
    search_hints: [],
    keyword_groups: {},
    negative_constraints: [],
    validation_hints: [],
    uncertainties: [],
    warnings,
    ...(model ? { model } : {}),
  };
}

function detectTaskLanguage(task: string): string {
  if (CZECH_DIACRITICS_PATTERN.test(task)) {
    return 'cs';
  }
  if (task.split('').every((char) => char.charCodeAt(0) <= 0x7f)) {
    return 'en';
  }
  return 'unknown';
}

function normalizeBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function resolveModelMetadata(providerConfig: ProviderConfig, modelInfo?: { provider: string; model: string }): { provider: string; model: string; live: boolean } {
  return {
    provider: modelInfo?.provider ?? providerConfig.provider,
    model: modelInfo?.model ?? providerConfig.model ?? DEFAULT_MODEL,
    live: providerConfig.live,
  };
}

function extractContentFromResponse(json: unknown): string {
  const choices = (json as { choices?: unknown[] }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('task normalizer provider response has no choices');
  }

  const content = (choices[0] as { message?: { content?: string } }).message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('task normalizer provider response has empty content');
  }

  return content;
}

function sanitizeKeywordGroups(keywordGroups: Record<string, string[]>): TaskIntentEnabled['keyword_groups'] {
  return {
    core_terms: keywordGroups.core_terms ?? [],
    ui_terms: keywordGroups.ui_terms ?? [],
    persistence_terms: keywordGroups.persistence_terms ?? [],
    cli_terms: keywordGroups.cli_terms ?? [],
    test_terms: keywordGroups.test_terms ?? [],
    ...keywordGroups,
  };
}

async function requestTaskNormalizerContent(args: {
  task: string;
  systemPrompt: string;
  providerConfig: ProviderConfig;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const liveAdapter = new OpenAiCompatibleAdapter(
    {
      ...args.providerConfig,
      timeoutMs: args.timeoutMs ?? args.providerConfig.timeoutMs,
    },
    args.fetchFn,
  ) as unknown as OpenAiCompatibleAdapterInternals;

  const { config, fetchFn } = liveAdapter;
  if (!config.apiKey) {
    throw new Error('task normalizer providerConfig is missing apiKey');
  }
  if (!config.baseUrl) {
    throw new Error('task normalizer providerConfig is missing baseUrl');
  }

  const resolvedModel = config.model ?? DEFAULT_MODEL;
  const resolvedTimeoutMs = args.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);

  try {
    const response = await fetchFn(normalizeBaseUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content: args.task },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`task normalizer provider returned HTTP ${response.status}`);
    }

    return extractContentFromResponse(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`task normalizer provider timed out after ${resolvedTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runTaskNormalizer(input: TaskNormalizerInput): Promise<TaskIntent> {
  if (!input.enabled) {
    return buildDisabledIntent(input.task);
  }

  if (!input.providerConfig) {
    const warning = 'Task normalizer enabled but no providerConfig was resolved; using fallback task intent.';
    console.warn(warning);
    return buildFallbackIntent(input.task, [warning]);
  }

  const model = resolveModelMetadata(input.providerConfig, input.modelInfo);

  try {
    const systemPrompt = fs.readFileSync(BUNDLED_TASK_NORMALIZER_SYSTEM_PROMPT_PATH, 'utf8');
    const rawContent = await requestTaskNormalizerContent({
      task: input.task,
      systemPrompt,
      providerConfig: input.providerConfig,
      fetchFn: input.fetchFn,
      timeoutMs: input.timeoutMs,
    });
    const parsed = parseTaskIntentJson(rawContent);

    if (!parsed.ok || !parsed.data) {
      return buildFallbackIntent(input.task, [`task normalizer parse failed: ${parsed.warning ?? 'unknown parse error'}`], model);
    }

    return {
      enabled: true,
      ok: true,
      source: 'llm',
      original_task: input.task,
      original_language: detectTaskLanguage(input.task),
      normalized_english_task: parsed.data.normalized_english_task,
      search_hints: parsed.data.search_hints,
      keyword_groups: sanitizeKeywordGroups(parsed.data.keyword_groups),
      negative_constraints: parsed.data.negative_constraints,
      validation_hints: parsed.data.validation_hints,
      uncertainties: parsed.data.uncertainties,
      warnings: parsed.warning ? [...parsed.data.warnings, parsed.warning] : parsed.data.warnings,
      model,
    };
  } catch (error) {
    return buildFallbackIntent(
      input.task,
      [`task normalizer request failed: ${error instanceof Error ? error.message : String(error)}`],
      model,
    );
  }
}
