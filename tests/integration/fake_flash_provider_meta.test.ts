import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';

import { OpenAiCompatibleAdapter } from '../../src/adapters/llm/openai_compatible_adapter.js';
import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';

const SECRET_OPENROUTER = 'sk-ope...cret';
const SECRET_DEEPSEEK = 'sk-dee...cret';
const LMSTUDIO_DUMMY_KEY = 'not-needed';

const REGISTRY = {
  version: 1,
  providers: {
    openrouter: {
      type: 'openai-compatible',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_env: 'OPENROUTER_API_KEY',
      models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat via OpenRouter', role: 'flash' }],
    },
    deepseek: {
      type: 'openai-compatible',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key_env: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
    },
    lmstudio: {
      type: 'openai-compatible',
      label: 'LM Studio',
      base_url: 'http://127.0.0.1:1234/v1',
      api_key_env: 'LMSTUDIO_API_KEY',
      models: [{ id: 'qwen3.5-9b', label: 'Qwen3.5 9B Local', role: 'flash' }],
    },
  },
  defaults: { flash: { provider: 'openrouter', model: 'deepseek/deepseek-chat' } },
};

const VALID_FLASH_MARKDOWN = [
  '# Task Summary',
  'Provider metadata fixture.',
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
  '- fixture only',
  '',
  '# Context Pack',
  'Deterministic fixture context pack.',
  '',
].join('\n');

function fakeLiveFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: VALID_FLASH_MARKDOWN } }] }),
  } as Response);
}

function makeAppData(envLines: string[]): string {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-provider-meta-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), YAML.stringify(REGISTRY), 'utf8');
  fs.writeFileSync(path.join(dir, '.env'), envLines.join('\n') + '\n', 'utf8');
  return appData;
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-provider-meta-repo-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  return repoRoot;
}

describe('fake flash provider metadata in run artifacts', () => {
  const originalLocalAppData = process.env.LOCALAPPDATA;

  afterEach(() => {
    process.env.LOCALAPPDATA = originalLocalAppData;
  });

  test('prompt live with fake OpenRouter provider writes provider/model metadata (no key)', async () => {
    const appData = makeAppData([`OPENROUTER_API_KEY=${SECRET_OPENROUTER}`]);
    const repoRoot = makeRepo();
    process.env.LOCALAPPDATA = appData;
    const adapter = new OpenAiCompatibleAdapter(
      { provider: 'openrouter', apiKey: 'unused-in-fake', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', live: true },
      fakeLiveFetch() as typeof fetch,
    );

    try {
      const result = await runPromptPipeline({ task: 'openrouter provider metadata', repoRoot, mock: false, adapter });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const meta = JSON.parse(fs.readFileSync(path.join(result.runDir, 'flash', 'flash_output_meta.json'), 'utf8'));
      expect(meta.provider).toBe('openrouter');
      expect(meta.provider_label).toBe('OpenRouter');
      expect(meta.model).toBe('deepseek/deepseek-chat');
      expect(meta.model_label).toBe('DeepSeek Chat via OpenRouter');
      expect(meta.live).toBe(true);
      expect(meta.baseUrl_host).toBe('openrouter.ai');
      expect(JSON.stringify(meta)).not.toContain(SECRET_OPENROUTER);

      const resolution = JSON.parse(fs.readFileSync(path.join(result.runDir, 'config_resolution.json'), 'utf8'));
      expect(resolution.provider).toBe('openrouter');
      expect(resolution.api_key_env).toBe('OPENROUTER_API_KEY');
      expect(resolution.api_key_source).toBe('global-env:OPENROUTER_API_KEY');
      expect(JSON.stringify(resolution)).not.toContain(SECRET_OPENROUTER);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('prompt live with fake DeepSeek provider writes provider/model metadata (no key)', async () => {
    const appData = makeAppData([`DEEPSEEK_API_KEY=${SECRET_DEEPSEEK}`]);
    const repoRoot = makeRepo();
    process.env.LOCALAPPDATA = appData;
    const adapter = new OpenAiCompatibleAdapter(
      { provider: 'deepseek', apiKey: 'unused-in-fake', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', live: true },
      fakeLiveFetch() as typeof fetch,
    );

    try {
      const result = await runPromptPipeline({
        task: 'deepseek provider metadata',
        repoRoot,
        mock: false,
        adapter,
        flashProvider: 'deepseek',
        flashModel: 'deepseek-chat',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const meta = JSON.parse(fs.readFileSync(path.join(result.runDir, 'flash', 'flash_output_meta.json'), 'utf8'));
      expect(meta.provider).toBe('deepseek');
      expect(meta.provider_label).toBe('DeepSeek');
      expect(meta.model).toBe('deepseek-chat');
      expect(meta.model_label).toBe('DeepSeek Chat');
      expect(meta.live).toBe(true);
      expect(meta.baseUrl_host).toBe('api.deepseek.com');
      expect(JSON.stringify(meta)).not.toContain(SECRET_DEEPSEEK);

      const resolution = JSON.parse(fs.readFileSync(path.join(result.runDir, 'config_resolution.json'), 'utf8'));
      expect(resolution.provider).toBe('deepseek');
      expect(resolution.model).toBe('deepseek-chat');
      expect(resolution.api_key_env).toBe('DEEPSEEK_API_KEY');
      expect(JSON.stringify(resolution)).not.toContain(SECRET_DEEPSEEK);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });

  test('prompt live with fake LM Studio provider writes live local metadata and no dummy key', async () => {
    const appData = makeAppData([`LMSTUDIO_API_KEY=${LMSTUDIO_DUMMY_KEY}`]);
    const repoRoot = makeRepo();
    process.env.LOCALAPPDATA = appData;
    const adapter = new OpenAiCompatibleAdapter(
      { provider: 'lmstudio', apiKey: LMSTUDIO_DUMMY_KEY, baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen3.5-9b', live: true },
      fakeLiveFetch() as typeof fetch,
    );

    try {
      const result = await runPromptPipeline({
        task: 'lmstudio provider metadata',
        repoRoot,
        mock: false,
        live: true,
        adapter,
        flashProvider: 'lmstudio',
        flashModel: 'qwen3.5-9b',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const meta = JSON.parse(fs.readFileSync(path.join(result.runDir, 'flash', 'flash_output_meta.json'), 'utf8'));
      expect(meta.provider).toBe('lmstudio');
      expect(meta.provider_label).toBe('LM Studio');
      expect(meta.model).toBe('qwen3.5-9b');
      expect(meta.model_label).toBe('Qwen3.5 9B Local');
      expect(meta.live).toBe(true);
      expect(meta.baseUrl_host).toBe('127.0.0.1');
      expect(JSON.stringify(meta)).not.toContain(LMSTUDIO_DUMMY_KEY);

      const resolution = JSON.parse(fs.readFileSync(path.join(result.runDir, 'config_resolution.json'), 'utf8'));
      expect(resolution.provider).toBe('lmstudio');
      expect(resolution.model).toBe('qwen3.5-9b');
      expect(resolution.api_key_env).toBe('LMSTUDIO_API_KEY');
      expect(resolution.api_key_source).toBe('global-env:LMSTUDIO_API_KEY');
      expect(JSON.stringify(resolution)).not.toContain(LMSTUDIO_DUMMY_KEY);
      expect(fs.existsSync(path.join(result.runDir, 'after'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'terminal_context.json'))).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(appData, { recursive: true, force: true });
    }
  });
});
