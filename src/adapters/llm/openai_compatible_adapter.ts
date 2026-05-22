import fs from 'fs';
import path from 'path';

import type { FlashAdapterResult, FlashInput, LlmAdapter } from './base.js';
import { LlmAdapterError } from './errors.js';
import type { ProviderConfig } from './provider_config.js';
import { extractFlashOutputMeta, writeFlashOutputMeta } from '../../core/context/flash_output_meta.js';
import { parseFlashOutput } from '../../core/context/markdown_flash_output_parser.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = [
  'You are a flash model for a coding context pipeline.',
  'Return ONLY the required Markdown contract with exactly 8 sections — no preamble, no explanation.',
  'The 8 sections are:',
  '# Task Summary',
  '# Relevant Files',
  '# Files To Read With Tools',
  '# Relevant Tests',
  '# Commands To Run',
  '# Selected Skills',
  '# Cautions',
  '# Context Pack',
  'Each section must start with a top-level heading exactly as shown above.',
  'Do not include any text before "# Task Summary".',
  'Do not include any additional sections.',
].join('\n');

function safeHost(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').split('/')[0];
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  // Strip trailing slash, then append /chat/completions
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

export class OpenAiCompatibleAdapter implements LlmAdapter {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly config: ProviderConfig,
    fetchFn?: typeof fetch,
  ) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  async run(input: FlashInput): Promise<FlashAdapterResult> {
    const { apiKey, baseUrl, model, timeoutMs, maxTokens, temperature, provider } = this.config;

    if (!apiKey) {
      throw new LlmAdapterError('flash provider is missing apiKey', {
        code: 'FLASH_PROVIDER_NOT_CONFIGURED',
        details: [`provider: ${provider}`, 'Set VIBECODE_FLASH_API_KEY or VIBECODE_API_KEY'],
      });
    }

    if (!baseUrl) {
      throw new LlmAdapterError('flash provider is missing baseUrl', {
        code: 'FLASH_PROVIDER_NOT_CONFIGURED',
        details: [`provider: ${provider}`, 'Set VIBECODE_FLASH_BASE_URL or VIBECODE_BASE_URL'],
      });
    }

    const runDir = path.join(path.resolve(input.workspaceRoot), '.vibecode', 'runs', input.runId);
    const flashDir = path.join(runDir, 'flash');
    const flashInputPath = path.join(flashDir, 'flash_input.md');

    // Read the saved flash_input.md (the canonical input)
    const flashInputMd = fs.existsSync(flashInputPath)
      ? fs.readFileSync(flashInputPath, 'utf8')
      : input.flashInputMd;

    const resolvedModel = model || DEFAULT_MODEL;
    const resolvedTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const endpoint = normalizeBaseUrl(baseUrl);

    const requestBody: Record<string, unknown> = {
      model: resolvedModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: flashInputMd },
      ],
    };
    if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;
    if (temperature !== undefined) requestBody.temperature = temperature;

    const controller = new AbortController();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(new LlmAdapterError(`flash provider timed out after ${resolvedTimeoutMs}ms`, {
          code: 'FLASH_PROVIDER_TIMEOUT',
          details: [
            `provider: ${provider}`,
            `model: ${resolvedModel}`,
            `baseUrl: ${safeHost(baseUrl)}`,
            `timeoutMs: ${resolvedTimeoutMs}`,
          ],
        }));
      }, resolvedTimeoutMs);
    });

    let response: Response;
    try {
      response = await Promise.race([
        this.fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (err: unknown) {
      if (err instanceof LlmAdapterError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LlmAdapterError(`flash provider timed out after ${resolvedTimeoutMs}ms`, {
          code: 'FLASH_PROVIDER_TIMEOUT',
          details: [
            `provider: ${provider}`,
            `model: ${resolvedModel}`,
            `baseUrl: ${safeHost(baseUrl)}`,
            `timeoutMs: ${resolvedTimeoutMs}`,
          ],
        });
      }
      throw new LlmAdapterError(`flash provider request failed: ${err instanceof Error ? err.message : String(err)}`, {
        code: 'FLASH_PROVIDER_REQUEST_FAILED',
        details: [
          `provider: ${provider}`,
          `model: ${resolvedModel}`,
          `baseUrl: ${safeHost(baseUrl)}`,
        ],
      });
    }

    if (!response.ok) {
      throw new LlmAdapterError(`flash provider returned HTTP ${response.status}`, {
        code: 'FLASH_PROVIDER_REQUEST_FAILED',
        details: [
          `provider: ${provider}`,
          `model: ${resolvedModel}`,
          `baseUrl: ${safeHost(baseUrl)}`,
          `status: ${response.status}`,
        ],
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new LlmAdapterError('flash provider returned non-JSON response body', {
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        details: [`provider: ${provider}`, `model: ${resolvedModel}`],
      });
    }

    // Extract content from choices[0].message.content
    const choices = (json as { choices?: unknown[] }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new LlmAdapterError('flash provider response has no choices', {
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        details: [`provider: ${provider}`, `model: ${resolvedModel}`],
      });
    }

    const content = (choices[0] as { message?: { content?: string } }).message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new LlmAdapterError('flash provider response choice has empty or missing content', {
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        details: [`provider: ${provider}`, `model: ${resolvedModel}`],
      });
    }

    const flashOutputMd = content;
    const flashOutputPath = path.join(flashDir, 'flash_output.md');
    const parsed = parseFlashOutput(flashOutputMd, flashOutputPath);

    if (!parsed.ok) {
      throw new LlmAdapterError(parsed.diagnostic?.message ?? 'flash output failed validation', {
        code: 'FLASH_OUTPUT_INVALID',
        path: parsed.diagnostic?.path,
        details: parsed.diagnostic?.details ?? [],
      });
    }

    // Only write artifacts after successful validation
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(flashOutputPath, flashOutputMd, 'utf8');

    const extractedMeta = extractFlashOutputMeta(parsed.sections);
    writeFlashOutputMeta(flashDir, extractedMeta);

    const toolCallsPath = path.join(flashDir, 'tool_calls.json');
    fs.writeFileSync(toolCallsPath, '[]\n', 'utf8');

    return {
      flashOutputMd,
      toolCalls: [],
      meta: {
        provider,
        model: resolvedModel,
        live: true,
        baseUrl_host: safeHost(baseUrl),
      },
    };
  }
}
