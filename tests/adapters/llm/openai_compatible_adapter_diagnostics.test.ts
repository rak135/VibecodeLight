import fs from 'fs';
import os from 'os';
import path from 'path';

import { LlmAdapterError } from '../../../src/adapters/llm/errors.js';
import { OpenAiCompatibleAdapter } from '../../../src/adapters/llm/openai_compatible_adapter.js';
import type { ProviderConfig } from '../../../src/adapters/llm/provider_config.js';

const TEST_API_KEY = 'secret-api-key';
const CLARIFIED_NON_JSON_MESSAGE = 'Provider API returned a non-JSON HTTP response. Flash output remains Markdown-first; this indicates an API endpoint, authentication, model, or provider configuration error.';

function makeWorkspace(runId = '20260524-000000-diagnostics') {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-openai-diagnostics-'));
  const flashDir = path.join(workspaceRoot, '.vibecode', 'runs', runId, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });
  fs.writeFileSync(path.join(flashDir, 'flash_input.md'), '# Flash Input\n\nDiagnostics fixture input\n', 'utf8');
  return { workspaceRoot, runId, flashDir };
}

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider: 'openrouter',
    apiKey: TEST_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    live: true,
    ...overrides,
  };
}

function headers(values: Record<string, string | null | undefined>) {
  return {
    get(name: string) {
      const lower = name.toLowerCase();
      const found = Object.entries(values).find(([key]) => key.toLowerCase() === lower);
      return found?.[1] ?? null;
    },
  };
}

function nonJsonFetch(body: string, opts: { status?: number; contentType?: string; requestId?: string; cfRay?: string } = {}) {
  return async () => ({
    ok: true,
    status: opts.status ?? 401,
    headers: headers({
      'content-type': opts.contentType ?? 'text/html',
      'x-request-id': opts.requestId,
      'cf-ray': opts.cfRay,
    }),
    text: async () => body,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response);
}

async function captureError(adapter: OpenAiCompatibleAdapter, args: { flashDir: string; runId: string; workspaceRoot: string }): Promise<LlmAdapterError> {
  try {
    await adapter.run({
      flashInputMd: '',
      flashDir: args.flashDir,
      runId: args.runId,
      workspaceRoot: args.workspaceRoot,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(LlmAdapterError);
    return error as LlmAdapterError;
  }
  throw new Error('Expected adapter.run to reject');
}

describe('OpenAiCompatibleAdapter provider diagnostics', () => {
  test('non-JSON response returns FLASH_PROVIDER_BAD_RESPONSE with clarified message', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch('<html>not json</html>') as typeof fetch);

      const error = await captureError(adapter, { flashDir, runId, workspaceRoot });

      expect(error.code).toBe('FLASH_PROVIDER_BAD_RESPONSE');
      expect(error.message).toBe(CLARIFIED_NON_JSON_MESSAGE);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('timeout diagnostic reports the resolved timeoutMs and never leaks the api key', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(
        config({ timeoutMs: 180000 }),
        async () => {
          throw new DOMException('aborted', 'AbortError');
        },
      );

      const error = await captureError(adapter, { flashDir, runId, workspaceRoot });
      expect(error.code).toBe('FLASH_PROVIDER_TIMEOUT');
      expect(error.message).toContain('180000ms');
      expect(error.details).toContain('timeoutMs: 180000');
      expect(JSON.stringify(error)).not.toContain(TEST_API_KEY);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('non-JSON response diagnostic includes http_status, content_type, and body_excerpt_redacted', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    const html = '<html><body>diagnostic body</body></html>';
    try {
      const adapter = new OpenAiCompatibleAdapter(
        config(),
        nonJsonFetch(html, { status: 502, contentType: 'text/html; charset=utf-8', requestId: 'req_test_123', cfRay: 'ray_test_456' }) as typeof fetch,
      );

      const error = await captureError(adapter, { flashDir, runId, workspaceRoot });

      expect(error.diagnostic).toMatchObject({
        provider_id: 'openrouter',
        model_id: 'deepseek/deepseek-chat',
        base_url_host: 'openrouter.ai',
        http_status: 502,
        content_type: 'text/html; charset=utf-8',
        body_excerpt_redacted: html,
        x_request_id: 'req_test_123',
        cf_ray: 'ray_test_456',
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('non-JSON response message says non-JSON HTTP response and Markdown-first', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch('<html>not json</html>') as typeof fetch);

      const error = await captureError(adapter, { flashDir, runId, workspaceRoot });

      expect(error.message).toContain('non-JSON HTTP response');
      expect(error.message).toContain('Markdown-first');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('non-JSON response diagnostic does NOT include api key value', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch(`<html>${TEST_API_KEY}</html>`) as typeof fetch);

      const error = await captureError(adapter, { flashDir, runId, workspaceRoot });
      const serializedDiagnostic = JSON.stringify(error.diagnostic);

      expect(serializedDiagnostic).not.toContain(TEST_API_KEY);
      expect(error.diagnostic?.body_excerpt_redacted).toBe('<html>[REDACTED]</html>');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('HTML body_excerpt is truncated at 800 chars', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    const html = `<html>${'x'.repeat(900)}</html>`;
    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch(html) as typeof fetch);

      const error = await captureError(adapter, { flashDir, runId, workspaceRoot });

      expect(error.diagnostic?.body_excerpt_redacted).toHaveLength(800);
      expect(error.diagnostic?.body_excerpt_redacted).toBe(html.slice(0, 800));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('No choices response returns FLASH_PROVIDER_BAD_RESPONSE', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(
        config(),
        async () => ({
          ok: true,
          status: 200,
          headers: headers({ 'content-type': 'application/json' }),
          text: async () => '{"choices":[]}',
          json: async () => ({ choices: [] }),
        } as unknown as Response),
      );

      const error = await captureError(adapter, { flashDir, runId, workspaceRoot });

      expect(error.code).toBe('FLASH_PROVIDER_BAD_RESPONSE');
      expect(error.message).toContain('Provider API returned a bad response');
      expect(error.message).toContain('Markdown-first');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('provider_error.json is written to flash dir on non-JSON response', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch('<html>not json</html>') as typeof fetch);

      await captureError(adapter, { flashDir, runId, workspaceRoot });

      expect(fs.existsSync(path.join(flashDir, 'provider_error.json'))).toBe(true);
      expect(fs.existsSync(path.join(flashDir, 'flash_output.md'))).toBe(false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('provider_error.json uses the orchestration-supplied flashDir', async () => {
    const runId = '20260524-000000-supplied-diagnostics';
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-openai-diagnostics-'));
    const flashDir = path.join(workspaceRoot, 'run-package', 'flash');
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(path.join(flashDir, 'flash_input.md'), '# Flash Input\n\nDiagnostics fixture input\n', 'utf8');

    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch('<html>not json</html>') as typeof fetch);

      await captureError(adapter, { flashDir, runId, workspaceRoot });

      expect(fs.existsSync(path.join(flashDir, 'provider_error.json'))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, '.vibecode', 'runs', runId, 'flash', 'provider_error.json'))).toBe(false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('provider_error.json does not include api key', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch(`<html>${TEST_API_KEY}</html>`) as typeof fetch);

      await captureError(adapter, { flashDir, runId, workspaceRoot });
      const json = JSON.parse(fs.readFileSync(path.join(flashDir, 'provider_error.json'), 'utf8'));
      const serializedArtifact = JSON.stringify(json);

      expect(json.api_key).toBeUndefined();
      expect(serializedArtifact).not.toContain(TEST_API_KEY);
      expect(json.body_excerpt_redacted).toBe('<html>[REDACTED]</html>');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('Authorization header is not in provider_error.json', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    try {
      const adapter = new OpenAiCompatibleAdapter(config(), nonJsonFetch('<html>not json</html>') as typeof fetch);

      await captureError(adapter, { flashDir, runId, workspaceRoot });
      const serializedArtifact = fs.readFileSync(path.join(flashDir, 'provider_error.json'), 'utf8');

      expect(serializedArtifact).not.toMatch(/authorization/i);
      expect(serializedArtifact).not.toMatch(/bearer/i);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('provider_error.json has correct structure', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    const html = '<html><body>structured diagnostic</body></html>';
    try {
      const adapter = new OpenAiCompatibleAdapter(
        config(),
        nonJsonFetch(html, { status: 401, contentType: 'text/html', requestId: 'req_structured', cfRay: 'ray_structured' }) as typeof fetch,
      );

      await captureError(adapter, { flashDir, runId, workspaceRoot });
      const json = JSON.parse(fs.readFileSync(path.join(flashDir, 'provider_error.json'), 'utf8'));

      expect(json).toMatchObject({
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
        message: CLARIFIED_NON_JSON_MESSAGE,
        provider_id: 'openrouter',
        model_id: 'deepseek/deepseek-chat',
        base_url_host: 'openrouter.ai',
        http_status: 401,
        content_type: 'text/html',
        body_excerpt_redacted: html,
        x_request_id: 'req_structured',
        cf_ray: 'ray_structured',
      });
      expect(typeof json.timestamp_utc).toBe('string');
      expect(json.timestamp_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
