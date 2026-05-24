import fs from 'fs';
import os from 'os';
import path from 'path';

import { LlmAdapterError } from '../../../src/adapters/llm/errors.js';
import { OpenAiCompatibleAdapter } from '../../../src/adapters/llm/openai_compatible_adapter.js';
import type { LlmAdapter } from '../../../src/adapters/llm/base.js';
import {
  BAD_PROVIDER_RESPONSE_TIP,
  runPromptCommand,
} from '../../../src/app/cli/index.js';

const SECRET_API_KEY = 'secret-progress-output-key';

const VALID_FLASH_MARKDOWN = [
  '# Task Summary',
  'CLI progress fake live flash output.',
  '',
  '# Relevant Files',
  '- README.md — fixture repository overview',
  '',
  '# Files To Read With Tools',
  '- README.md — inspect repository overview',
  '',
  '# Relevant Tests',
  '- pnpm test — run tests',
  '',
  '# Commands To Run',
  '- pnpm test — run tests',
  '',
  '# Selected Skills',
  '- test-driven-development — keep CLI progress tests focused',
  '',
  '# Cautions',
  '- test fixture only',
  '',
  '# Context Pack',
  'Deterministic context pack for CLI progress tests.',
  '',
].join('\n');

function makeRepo(prefix = 'vibecode-cli-progress-'): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

function makeWriter() {
  let text = '';
  return {
    writer: { write: (chunk: string) => { text += chunk; return true; } },
    get text() { return text; },
  };
}

function fakeLiveFetch() {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content: VALID_FLASH_MARKDOWN } }] }),
  } as unknown as Response);
}

function nonJsonFetch(body: string) {
  return async () => ({
    ok: true,
    status: 401,
    headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/html' : null },
    text: async () => body,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
  } as unknown as Response);
}

describe('prompt command progress printing', () => {
  test('prompt --mock non-json prints progress phases to stderr', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    try {
      await runPromptCommand({
        task: 'mock cli progress test',
        repoRoot,
        mock: true,
        live: false,
        json: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(stderr.text).toContain('[vibecode] scan_started: Scanning repository...');
      expect(stderr.text).toContain('[vibecode] scan_completed: Repository scanned');
      expect(stderr.text).toContain('[vibecode] flash_input_built: Flash input built');
      expect(stderr.text).toContain('[vibecode] provider_resolved: Using provider mock');
      expect(stderr.text).toContain('[vibecode] flash_request_started: Calling flash provider...');
      expect(stderr.text).toContain('[vibecode] flash_response_received: Flash response received');
      expect(stderr.text).toContain('[vibecode] flash_output_validated: Flash output validated');
      expect(stderr.text).toContain('[vibecode] context_pack_written: Context pack written');
      expect(stderr.text).toContain('[vibecode] final_prompt_written: Final prompt rendered');
      expect(stdout.text).toContain('final_prompt:');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('prompt --mock json does NOT include progress in stdout JSON', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    try {
      await runPromptCommand({
        task: 'mock json cli progress test',
        repoRoot,
        mock: true,
        live: false,
        json: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const lines = stdout.text.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(stdout.text).not.toContain('[vibecode]');
      const envelope = JSON.parse(lines[0]);
      expect(envelope.ok).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('prompt --live with fake adapter non-json prints provider phase to stderr', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openrouter',
      apiKey: SECRET_API_KEY,
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
      live: true,
    }, fakeLiveFetch() as typeof fetch);
    try {
      await runPromptCommand({
        task: 'fake live cli progress test',
        repoRoot,
        mock: false,
        live: true,
        flashProvider: 'openrouter',
        flashModel: 'deepseek-chat',
        adapter,
        json: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(stderr.text).toContain('[vibecode] provider_resolved: Using provider openrouter / deepseek-chat');
      expect(stderr.text).toContain('[vibecode] flash_request_started: Calling flash provider...');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('prompt --live with fake adapter json is clean single-line JSON', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openrouter',
      apiKey: SECRET_API_KEY,
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
      live: true,
    }, fakeLiveFetch() as typeof fetch);
    try {
      await runPromptCommand({
        task: 'fake live json cli progress test',
        repoRoot,
        mock: false,
        live: true,
        flashProvider: 'openrouter',
        flashModel: 'deepseek-chat',
        adapter,
        json: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      const lines = stdout.text.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('[vibecode]');
      expect(JSON.parse(lines[0]).ok).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('on FLASH_PROVIDER_BAD_RESPONSE, non-json prints helpful tip to stderr', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const adapter: LlmAdapter = {
      run: async () => {
        throw new LlmAdapterError('provider bad response for CLI progress test', {
          code: 'FLASH_PROVIDER_BAD_RESPONSE',
          details: ['safe diagnostic detail'],
        });
      },
    };
    try {
      const result = await runPromptCommand({
        task: 'bad response non-json cli progress test',
        repoRoot,
        mock: false,
        live: true,
        flashProvider: 'openrouter',
        flashModel: 'deepseek-chat',
        adapter,
        json: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(false);
      expect(stderr.text).toContain(BAD_PROVIDER_RESPONSE_TIP);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('on FLASH_PROVIDER_BAD_RESPONSE, json error contains artifacts with provider_error.json path', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openrouter',
      apiKey: SECRET_API_KEY,
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
      live: true,
    }, nonJsonFetch('<html>not json</html>') as typeof fetch);
    try {
      const result = await runPromptCommand({
        task: 'bad response json cli progress test',
        repoRoot,
        mock: false,
        live: true,
        flashProvider: 'openrouter',
        flashModel: 'deepseek-chat',
        adapter,
        json: true,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(false);
      const envelope = JSON.parse(stdout.text.trim());
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('FLASH_PROVIDER_BAD_RESPONSE');
      expect(envelope.error.artifacts).toEqual(expect.arrayContaining([expect.stringContaining(path.join('flash', 'provider_error.json'))]));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('no api key appears in stderr progress output', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openrouter',
      apiKey: SECRET_API_KEY,
      baseUrl: 'https://api.example.com/v1',
      model: 'deepseek-chat',
      live: true,
    }, fakeLiveFetch() as typeof fetch);
    try {
      await runPromptCommand({
        task: 'secret-free progress output test',
        repoRoot,
        mock: false,
        live: true,
        flashProvider: 'openrouter',
        flashModel: 'deepseek-chat',
        adapter,
        json: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(stderr.text).not.toContain(SECRET_API_KEY);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('--mock still returns ok:true', async () => {
    const repoRoot = makeRepo();
    const stdout = makeWriter();
    const stderr = makeWriter();
    try {
      const result = await runPromptCommand({
        task: 'mock still succeeds cli progress test',
        repoRoot,
        mock: true,
        live: false,
        json: false,
        stdout: stdout.writer,
        stderr: stderr.writer,
      });

      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
