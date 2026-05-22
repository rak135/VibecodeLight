import fs from 'fs';
import os from 'os';
import path from 'path';

import { OpenAiCompatibleAdapter } from '../../../src/adapters/llm/openai_compatible_adapter.js';
import { parseFlashOutput } from '../../../src/core/context/markdown_flash_output_parser.js';

const VALID_FLASH_MARKDOWN = [
  '# Task Summary',
  'Valid live flash output for automated tests.',
  '',
  '# Relevant Files',
  '- README.md — fixture repository overview',
  '',
  '# Files To Read With Tools',
  '- README.md — inspect repository overview before implementation',
  '',
  '# Relevant Tests',
  '- pnpm test — run the default test suite',
  '',
  '# Commands To Run',
  '- pnpm test — run the default test suite',
  '',
  '# Selected Skills',
  '- test-driven-development — validate contract before changing code',
  '',
  '# Cautions',
  '- live provider test fixture only; do not treat as model guidance',
  '',
  '# Context Pack',
  'This live flash context pack is deterministic for tests.',
  'It validates the end-to-end flash artifact contract.',
  '',
].join('\n');

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-openai-adapter-'));
  const runId = '20260522-000000-live-test';
  const flashDir = path.join(workspaceRoot, '.vibecode', 'runs', runId, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });
  fs.writeFileSync(path.join(flashDir, 'flash_input.md'), '# Flash Input\n\nAdapter fixture input\n', 'utf8');
  return { workspaceRoot, runId, flashDir };
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()];
}

describe('OpenAiCompatibleAdapter', () => {
  test('builds the expected POST request shape and writes valid flash artifacts', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const fakeFetch = async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: VALID_FLASH_MARKDOWN } }] }),
      } as Response;
    };

    try {
      const adapter = new OpenAiCompatibleAdapter(
        {
          provider: 'openrouter',
          apiKey: 'secret-api-key',
          baseUrl: 'https://api.example.com/v1/',
          live: true,
          timeoutMs: 1000,
          maxTokens: 512,
          temperature: 0.1,
        },
        fakeFetch as typeof fetch,
      );

      const result = await adapter.run({
        flashInputMd: 'ignored because adapter reads the saved file',
        runId,
        workspaceRoot,
      });

      expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
      expect(capturedInit?.method).toBe('POST');
      expect(getHeader(capturedInit?.headers, 'authorization')).toBe('Bearer secret-api-key');
      expect(getHeader(capturedInit?.headers, 'content-type')).toBe('application/json');

      const body = JSON.parse(String(capturedInit?.body ?? '{}'));
      expect(body).toEqual({
        model: 'gpt-4o-mini',
        messages: [
          expect.objectContaining({ role: 'system', content: expect.any(String) }),
          { role: 'user', content: '# Flash Input\n\nAdapter fixture input\n' },
        ],
        max_tokens: 512,
        temperature: 0.1,
      });
      expect(body.messages[0].content).toContain('ONLY');
      expect(body.messages[0].content).toContain('8 sections');

      const outputPath = path.join(flashDir, 'flash_output.md');
      const metaPath = path.join(flashDir, 'flash_output_meta.json');
      const toolCallsPath = path.join(flashDir, 'tool_calls.json');

      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(VALID_FLASH_MARKDOWN);
      expect(fs.existsSync(metaPath)).toBe(true);
      expect(fs.existsSync(toolCallsPath)).toBe(true);
      expect(readJson(toolCallsPath)).toEqual([]);
      expect(result.toolCalls).toEqual([]);
      expect(result.meta).toEqual({
        provider: 'openrouter',
        model: 'gpt-4o-mini',
        live: true,
        baseUrl_host: 'api.example.com',
      });
      expect(fs.readFileSync(metaPath, 'utf8')).not.toContain('secret-api-key');
      expect(fs.readFileSync(outputPath, 'utf8')).not.toContain('secret-api-key');

      const parsed = parseFlashOutput(fs.readFileSync(outputPath, 'utf8'), outputPath);
      expect(parsed.ok).toBe(true);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('rejects missing apiKey with FLASH_PROVIDER_NOT_CONFIGURED', async () => {
    const { workspaceRoot, runId } = makeWorkspace();

    try {
      const adapter = new OpenAiCompatibleAdapter({
        provider: 'openrouter',
        baseUrl: 'https://api.example.com/v1',
        live: true,
      } as never);

      await expect(adapter.run({ flashInputMd: '', runId, workspaceRoot })).rejects.toMatchObject({
        code: 'FLASH_PROVIDER_NOT_CONFIGURED',
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('rejects missing baseUrl with FLASH_PROVIDER_NOT_CONFIGURED', async () => {
    const { workspaceRoot, runId } = makeWorkspace();

    try {
      const adapter = new OpenAiCompatibleAdapter({
        provider: 'openrouter',
        apiKey: 'secret-api-key',
        live: true,
      } as never);

      await expect(adapter.run({ flashInputMd: '', runId, workspaceRoot })).rejects.toMatchObject({
        code: 'FLASH_PROVIDER_NOT_CONFIGURED',
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('uses a default model when none is provided', async () => {
    const { workspaceRoot, runId } = makeWorkspace();
    let capturedBody = '';

    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: VALID_FLASH_MARKDOWN } }] }),
      } as Response;
    };

    try {
      const adapter = new OpenAiCompatibleAdapter(
        {
          provider: 'openrouter',
          apiKey: 'secret-api-key',
          baseUrl: 'https://api.example.com/v1',
          live: true,
        },
        fakeFetch as typeof fetch,
      );

      await adapter.run({ flashInputMd: '', runId, workspaceRoot });
      expect(JSON.parse(capturedBody).model).toBe('gpt-4o-mini');
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('times out with FLASH_PROVIDER_TIMEOUT', async () => {
    const { workspaceRoot, runId } = makeWorkspace();

    try {
      const adapter = new OpenAiCompatibleAdapter(
        {
          provider: 'openrouter',
          apiKey: 'secret-api-key',
          baseUrl: 'https://api.example.com/v1',
          live: true,
          timeoutMs: 5,
        },
        async () => new Promise<Response>(() => {
          // intentionally never resolves
        }),
      );

      await expect(adapter.run({ flashInputMd: '', runId, workspaceRoot })).rejects.toMatchObject({
        code: 'FLASH_PROVIDER_TIMEOUT',
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('maps non-2xx responses to FLASH_PROVIDER_REQUEST_FAILED with status details', async () => {
    const { workspaceRoot, runId } = makeWorkspace();

    try {
      const adapter = new OpenAiCompatibleAdapter(
        {
          provider: 'openrouter',
          apiKey: 'secret-api-key',
          baseUrl: 'https://api.example.com/v1',
          live: true,
        },
        async () => ({
          ok: false,
          status: 503,
          json: async () => ({}),
        } as Response),
      );

      await expect(adapter.run({ flashInputMd: '', runId, workspaceRoot })).rejects.toMatchObject({
        code: 'FLASH_PROVIDER_REQUEST_FAILED',
        details: expect.arrayContaining(['status: 503']),
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('rejects invalid markdown with FLASH_OUTPUT_INVALID before downstream artifacts are created', async () => {
    const { workspaceRoot, runId, flashDir } = makeWorkspace();

    try {
      const adapter = new OpenAiCompatibleAdapter(
        {
          provider: 'openrouter',
          apiKey: 'secret-api-key',
          baseUrl: 'https://api.example.com/v1',
          live: true,
        },
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '# Task Summary\nOnly one section\n' } }] }),
        } as Response),
      );

      await expect(adapter.run({ flashInputMd: '', runId, workspaceRoot })).rejects.toMatchObject({
        code: 'FLASH_OUTPUT_INVALID',
      });

      expect(fs.existsSync(path.join(flashDir, 'flash_output.md'))).toBe(false);
      expect(fs.existsSync(path.join(flashDir, 'flash_output_meta.json'))).toBe(false);
      expect(fs.existsSync(path.join(flashDir, 'tool_calls.json'))).toBe(false);
      expect(fs.existsSync(path.join(workspaceRoot, '.vibecode', 'runs', runId, 'output'))).toBe(false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('rejects bad provider payloads with FLASH_PROVIDER_BAD_RESPONSE', async () => {
    const { workspaceRoot, runId } = makeWorkspace();

    try {
      const adapter = new OpenAiCompatibleAdapter(
        {
          provider: 'openrouter',
          apiKey: 'secret-api-key',
          baseUrl: 'https://api.example.com/v1',
          live: true,
        },
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [] }),
        } as Response),
      );

      await expect(adapter.run({ flashInputMd: '', runId, workspaceRoot })).rejects.toMatchObject({
        code: 'FLASH_PROVIDER_BAD_RESPONSE',
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
