import fs from 'fs';
import path from 'path';

import type { FlashAdapterResult, FlashInput, LlmAdapter } from './base.js';
import { LlmAdapterError } from './errors.js';
import type { ProviderConfig } from './provider_config.js';
import { extractFlashOutputMeta, writeFlashOutputMeta } from '../../core/context/flash_output_meta.js';
import { parseFlashOutput } from '../../core/context/markdown_flash_output_parser.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 30_000;
const PROVIDER_BODY_EXCERPT_LIMIT = 800;
const NON_JSON_PROVIDER_MESSAGE = 'Provider API returned a non-JSON HTTP response. Flash output remains Markdown-first; this indicates an API endpoint, authentication, model, or provider configuration error.';
const BAD_PROVIDER_RESPONSE_PREFIX = 'Provider API returned a bad response. Flash output remains Markdown-first; this indicates an API endpoint, authentication, model, or provider configuration error.';

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

function truncateBodyExcerpt(body: string | undefined, apiKey?: string): string {
  const safeBody = apiKey ? (body ?? '').split(apiKey).join('[REDACTED]') : (body ?? '');
  return safeBody.slice(0, PROVIDER_BODY_EXCERPT_LIMIT);
}

function getResponseHeader(response: Response, name: string): string | null {
  const responseWithHeaders = response as Response & { headers?: { get?: (headerName: string) => string | null } };
  return responseWithHeaders.headers?.get?.(name) ?? null;
}

async function readResponseTextForDiagnostics(response: Response): Promise<string | undefined> {
  const responseWithHelpers = response as Response & {
    clone?: () => Response;
    text?: () => Promise<string>;
  };

  try {
    if (typeof responseWithHelpers.clone === 'function') {
      return await responseWithHelpers.clone().text();
    }
    if (typeof responseWithHelpers.text === 'function') {
      return await responseWithHelpers.text();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function providerResponseDiagnostic(args: {
  code: string;
  message: string;
  provider: string;
  model: string;
  baseUrl: string;
  response: Response;
  bodyText?: string;
  apiKey?: string;
}): Record<string, unknown> {
  return {
    code: args.code,
    message: args.message,
    provider_id: args.provider,
    model_id: args.model,
    base_url_host: safeHost(args.baseUrl),
    http_status: args.response.status,
    content_type: getResponseHeader(args.response, 'content-type') ?? 'unknown',
    body_excerpt_redacted: truncateBodyExcerpt(args.bodyText, args.apiKey),
    x_request_id: getResponseHeader(args.response, 'x-request-id'),
    cf_ray: getResponseHeader(args.response, 'cf-ray'),
  };
}

function providerResponseDetails(diagnostic: Record<string, unknown>): string[] {
  const details = [
    `provider: ${String(diagnostic.provider_id ?? '')}`,
    `model: ${String(diagnostic.model_id ?? '')}`,
    `baseUrl: ${String(diagnostic.base_url_host ?? '')}`,
  ];
  if (typeof diagnostic.http_status === 'number') details.push(`status: ${diagnostic.http_status}`);
  if (typeof diagnostic.content_type === 'string') details.push(`contentType: ${diagnostic.content_type}`);
  const xRequestId = diagnostic.x_request_id;
  if (typeof xRequestId === 'string') details.push(`x-request-id: ${xRequestId}`);
  const cfRay = diagnostic.cf_ray;
  if (typeof cfRay === 'string') details.push(`cf-ray: ${cfRay}`);
  return details;
}

function writeProviderErrorArtifact(flashDir: string, error: LlmAdapterError): void {
  if (!error.diagnostic) return;

  const diagnostic = error.diagnostic;
  const artifact = {
    code: error.code,
    message: error.message,
    provider_id: diagnostic.provider_id ?? null,
    model_id: diagnostic.model_id ?? null,
    base_url_host: diagnostic.base_url_host ?? null,
    http_status: diagnostic.http_status ?? null,
    content_type: diagnostic.content_type ?? 'unknown',
    body_excerpt_redacted: diagnostic.body_excerpt_redacted ?? '',
    x_request_id: diagnostic.x_request_id ?? null,
    cf_ray: diagnostic.cf_ray ?? null,
    timestamp_utc: new Date().toISOString(),
  };

  fs.mkdirSync(flashDir, { recursive: true });
  fs.writeFileSync(path.join(flashDir, 'provider_error.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
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

    const flashDir = path.resolve(input.flashDir);
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

    const responseBodyForDiagnostics = await readResponseTextForDiagnostics(response);

    if (!response.ok) {
      const message = `flash provider returned HTTP ${response.status}`;
      const diagnostic = providerResponseDiagnostic({
        code: 'FLASH_PROVIDER_REQUEST_FAILED',
        message,
        provider,
        model: resolvedModel,
        baseUrl,
        response,
        bodyText: responseBodyForDiagnostics,
        apiKey,
      });
      const error = new LlmAdapterError(message, {
        code: 'FLASH_PROVIDER_REQUEST_FAILED',
        details: providerResponseDetails(diagnostic),
        diagnostic,
      });
      writeProviderErrorArtifact(flashDir, error);
      throw error;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      const diagnostic = providerResponseDiagnostic({
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        message: NON_JSON_PROVIDER_MESSAGE,
        provider,
        model: resolvedModel,
        baseUrl,
        response,
        bodyText: responseBodyForDiagnostics,
        apiKey,
      });
      const error = new LlmAdapterError(NON_JSON_PROVIDER_MESSAGE, {
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        details: providerResponseDetails(diagnostic),
        diagnostic,
      });
      writeProviderErrorArtifact(flashDir, error);
      throw error;
    }

    // Extract content from choices[0].message.content
    const choices = (json as { choices?: unknown[] }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      const message = `${BAD_PROVIDER_RESPONSE_PREFIX} Response has no choices.`;
      const diagnostic = providerResponseDiagnostic({
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        message,
        provider,
        model: resolvedModel,
        baseUrl,
        response,
        bodyText: responseBodyForDiagnostics,
        apiKey,
      });
      const error = new LlmAdapterError(message, {
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        details: providerResponseDetails(diagnostic),
        diagnostic,
      });
      writeProviderErrorArtifact(flashDir, error);
      throw error;
    }

    const content = (choices[0] as { message?: { content?: string } }).message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const message = `${BAD_PROVIDER_RESPONSE_PREFIX} Response choice has empty or missing content.`;
      const diagnostic = providerResponseDiagnostic({
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        message,
        provider,
        model: resolvedModel,
        baseUrl,
        response,
        bodyText: responseBodyForDiagnostics,
        apiKey,
      });
      const error = new LlmAdapterError(message, {
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        details: providerResponseDetails(diagnostic),
        diagnostic,
      });
      writeProviderErrorArtifact(flashDir, error);
      throw error;
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
