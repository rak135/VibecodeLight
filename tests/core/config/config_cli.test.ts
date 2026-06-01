import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

import YAML from 'yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

const SECRET = 'sk-cli-do-not-print';
const LMSTUDIO_DUMMY_KEY = 'not-needed';

const REGISTRY = {
  version: 1,
  providers: {
    openrouter: {
      type: 'openai-compatible',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_env: 'OPENROUTER_API_KEY',
      models: [
        { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat via OpenRouter', role: 'flash' },
        { id: 'deepseek/deepseek-reasoner', role: 'flash' },
      ],
    },
    deepseek: {
      type: 'openai-compatible',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key_env: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
    },
  },
  defaults: { flash: { provider: 'openrouter', model: 'deepseek/deepseek-chat', timeout_ms: 30000 } },
};

const LMSTUDIO_REGISTRY = {
  version: 1,
  providers: {
    lmstudio: {
      type: 'openai-compatible',
      label: 'LM Studio',
      base_url: 'http://127.0.0.1:1234/v1',
      api_key_env: 'LMSTUDIO_API_KEY',
      models: [{ id: 'qwen3.5-9b', label: 'Qwen3.5 9B Local', role: 'flash' }],
    },
  },
  defaults: { flash: { provider: 'lmstudio', model: 'qwen3.5-9b', timeout_ms: 30000 } },
};

const VALID_FLASH_MARKDOWN = [
  '# Task Summary',
  'LM Studio CLI live fixture.',
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
  '- test-driven-development — keep coverage before changes',
  '',
  '# Cautions',
  '- fixture only',
  '',
  '# Context Pack',
  'Deterministic fixture context pack.',
  '',
].join('\n');

async function startFakeOpenAiServer() {
  const script = `
    const http = require('http');
    const response = ${JSON.stringify(VALID_FLASH_MARKDOWN)};
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: response } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      process.stdout.write(String(address.port) + '\\n');
    });
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake provider server did not start')), 5000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const firstLine = stdout.split(/\r?\n/)[0];
      const parsed = Number(firstLine);
      if (parsed > 0) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake provider server exited with ${code}: ${stderr}`));
    });
  });
  return { child, port };
}

function lmstudioRegistryForPort(port: number) {
  return {
    version: 1,
    providers: {
      lmstudio: {
        type: 'openai-compatible',
        label: 'LM Studio',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key_env: 'LMSTUDIO_API_KEY',
        models: [{ id: 'qwen3.5-9b', label: 'Qwen3.5 9B Local', role: 'flash' }],
      },
    },
    defaults: { flash: { provider: 'lmstudio', model: 'qwen3.5-9b', timeout_ms: 1000 } },
  };
}

function runCli(args: string[], cwd: string, localAppData?: string) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.VIBECODE_PROVIDER;
  delete env.VIBECODE_API_KEY;
  delete env.VIBECODE_MODEL;
  delete env.VIBECODE_BASE_URL;
  delete env.VIBECODE_FLASH_PROVIDER;
  delete env.VIBECODE_FLASH_API_KEY;
  delete env.VIBECODE_FLASH_MODEL;
  delete env.VIBECODE_FLASH_BASE_URL;
  delete env.OPENROUTER_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.LMSTUDIO_API_KEY;
  if (localAppData) env.LOCALAPPDATA = localAppData;
  return spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf8', timeout: 60000, env });
}

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-cli-'));
}

function makeAppData(withConfig: boolean, withEnv: boolean) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-cli-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  if (withConfig) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), YAML.stringify(REGISTRY), 'utf8');
  }
  if (withEnv) {
    fs.writeFileSync(path.join(dir, '.env'), `OPENROUTER_API_KEY=${SECRET}\n`, 'utf8');
  }
  return appData;
}

function makeAppDataWithRegistry(registry: unknown, envLines: string[]) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-cli-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), YAML.stringify(registry), 'utf8');
  fs.writeFileSync(path.join(dir, '.env'), `${envLines.join('\n')}\n`, 'utf8');
  return appData;
}

describe('config CLI', () => {
  let tmpRepo: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    tmpRepo = makeRepo();
    cleanup.push(tmpRepo);
  });

  afterEach(() => {
    while (cleanup.length) {
      const dir = cleanup.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('config paths --json returns a stable envelope', () => {
    const result = runCli(['config', 'paths', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveProperty('global_dir');
    expect(payload.data).toHaveProperty('global_config');
    expect(payload.data).toHaveProperty('global_env');
    expect(payload.data.local_config).toBe(path.join(tmpRepo, '.vibecode', 'config.yaml'));
    expect(payload.artifacts).toEqual([]);
    expect(payload.warnings).toEqual([]);
  });

  test('config show --json returns resolved registry config without API keys', () => {
    const appData = makeAppData(true, true);
    cleanup.push(appData);

    const result = runCli(['config', 'show', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SECRET);

    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.provider).toBe('openrouter');
    expect(payload.data.model).toBe('deepseek/deepseek-chat');
    expect(payload.data.has_api_key).toBe(true);
    expect(payload.data.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(payload.data.source_map.apiKey).toBe('env');
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(payload.data).not.toHaveProperty('apiKey');
  });

  test('config providers --json lists all providers and per-provider API key status', () => {
    const appData = makeAppData(true, true);
    cleanup.push(appData);

    const result = runCli(['config', 'providers', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    const ids = payload.data.providers.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(['deepseek', 'openrouter']);
    const openrouter = payload.data.providers.find((p: { id: string }) => p.id === 'openrouter');
    expect(openrouter.has_api_key).toBe(true);
    expect(openrouter.api_key_env).toBe('OPENROUTER_API_KEY');
    const deepseek = payload.data.providers.find((p: { id: string }) => p.id === 'deepseek');
    expect(deepseek.has_api_key).toBe(false);
    expect(payload.data.active_provider).toBe('openrouter');
    expect(payload.data.config_source).toBe('global');
  });

  test('config models --json lists models per provider', () => {
    const appData = makeAppData(true, true);
    cleanup.push(appData);

    const result = runCli(['config', 'models', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    const openrouter = payload.data.providers.find((p: { id: string }) => p.id === 'openrouter');
    expect(openrouter.models.map((m: { id: string }) => m.id)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner']);
  });

  test('config providers/models include LM Studio and never print its dummy key', () => {
    const appData = makeAppDataWithRegistry(LMSTUDIO_REGISTRY, [`LMSTUDIO_API_KEY=${LMSTUDIO_DUMMY_KEY}`]);
    cleanup.push(appData);

    const providersResult = runCli(['config', 'providers', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(providersResult.status).toBe(0);
    expect(providersResult.stdout).not.toContain(LMSTUDIO_DUMMY_KEY);
    const providersPayload = JSON.parse(providersResult.stdout.trim());
    expect(providersPayload.ok).toBe(true);
    expect(providersPayload.data.active_provider).toBe('lmstudio');
    const lmstudio = providersPayload.data.providers.find((p: { id: string }) => p.id === 'lmstudio');
    expect(lmstudio.label).toBe('LM Studio');
    expect(lmstudio.type).toBe('openai-compatible');
    expect(lmstudio.baseUrl_host).toBe('127.0.0.1');
    expect(lmstudio.api_key_env).toBe('LMSTUDIO_API_KEY');
    expect(lmstudio.has_api_key).toBe(true);

    const modelsResult = runCli(['config', 'models', '--provider', 'lmstudio', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(modelsResult.status).toBe(0);
    expect(modelsResult.stdout).not.toContain(LMSTUDIO_DUMMY_KEY);
    const modelsPayload = JSON.parse(modelsResult.stdout.trim());
    const lmstudioModels = modelsPayload.data.providers.find((p: { id: string }) => p.id === 'lmstudio');
    expect(lmstudioModels.models).toEqual([{ id: 'qwen3.5-9b', label: 'Qwen3.5 9B Local', role: 'flash' }]);
  });

  test('prompt --live --flash-provider lmstudio uses the live adapter and not mock', async () => {
    const server = await startFakeOpenAiServer();
    const appData = makeAppDataWithRegistry(lmstudioRegistryForPort(server.port), [`LMSTUDIO_API_KEY=${LMSTUDIO_DUMMY_KEY}`]);
    cleanup.push(appData);
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# fixture\n', 'utf8');

    try {
      const result = runCli(
        ['prompt', 'lmstudio CLI live fixture', '--repo', tmpRepo, '--live', '--flash-provider', 'lmstudio', '--flash-model', 'qwen3.5-9b', '--json'],
        tmpRepo,
        appData,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(LMSTUDIO_DUMMY_KEY);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload.ok).toBe(true);
      const runDir = payload.data.runDir;
      const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'flash', 'flash_output_meta.json'), 'utf8'));
      expect(meta.live).toBe(true);
      expect(meta.provider).toBe('lmstudio');
      expect(meta.model).toBe('qwen3.5-9b');
      expect(meta.baseUrl_host).toBe('127.0.0.1');
      expect(JSON.stringify(meta)).not.toContain(LMSTUDIO_DUMMY_KEY);
      const resolution = JSON.parse(fs.readFileSync(path.join(runDir, 'config_resolution.json'), 'utf8'));
      expect(resolution.provider).toBe('lmstudio');
      expect(resolution.model).toBe('qwen3.5-9b');
      expect(JSON.stringify(resolution)).not.toContain(LMSTUDIO_DUMMY_KEY);
      expect(fs.existsSync(path.join(runDir, 'flash', 'flash_output.md'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'output', 'context_pack.md'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'output', 'final_prompt.md'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'after'))).toBe(false);
      expect(fs.existsSync(path.join(runDir, 'terminal_context.json'))).toBe(false);
    } finally {
      server.child.kill();
    }
  });

  test('config init-local creates a local registry config from global', () => {
    const appData = makeAppData(true, false);
    cleanup.push(appData);

    const result = runCli(['config', 'init-local', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.created).toBe(true);
    expect(payload.data.created_from_global).toBe(true);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRepo, 'config.yaml'))).toBe(false);
    expect(payload.data.local_config_path).toBe(path.join(tmpRepo, '.vibecode', 'config.yaml'));
    expect(payload.artifacts).toEqual([path.join(tmpRepo, '.vibecode', 'config.yaml')]);
    expect(fs.readFileSync(path.join(tmpRepo, '.vibecode', 'config.yaml'), 'utf8')).toContain('openrouter');
  });

  test('config sync --from-global copies the registry to local', () => {
    const appData = makeAppData(true, false);
    cleanup.push(appData);

    const result = runCli(['config', 'sync', '--from-global', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.direction).toBe('from-global');
    expect(payload.data.destination).toBe(path.join(tmpRepo, '.vibecode', 'config.yaml'));
    expect(fs.existsSync(path.join(tmpRepo, 'config.yaml'))).toBe(false);
    expect(payload.artifacts).toEqual([path.join(tmpRepo, '.vibecode', 'config.yaml')]);
    expect(fs.readFileSync(path.join(tmpRepo, '.vibecode', 'config.yaml'), 'utf8')).toContain('openrouter');
  });

  test('config sync --to-global is disabled and returns CONFIG_SYNC_TO_GLOBAL_DISABLED', () => {
    const appData = makeAppData(false, false);
    cleanup.push(appData);
    const localPath = path.join(tmpRepo, '.vibecode', 'config.yaml');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, YAML.stringify({ providers: { localhost: { type: 'openai-compatible', base_url: 'https://local.invalid', api_key_env: 'LOCAL_KEY', models: [] } }, defaults: { flash: { provider: 'localhost' } } }), 'utf8');

    const result = runCli(['config', 'sync', '--to-global', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('CONFIG_SYNC_TO_GLOBAL_DISABLED');
    expect(payload.error.message).toContain('disabled');
    // global config must not have been written
    expect(fs.existsSync(path.join(appData, 'vibecodelight', 'config.yaml'))).toBe(false);
  });

  test('config sync never copies the .env file', () => {
    const appData = makeAppData(true, true);
    cleanup.push(appData);

    runCli(['config', 'sync', '--from-global', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', '.env'))).toBe(false);
    const localConfig = fs.readFileSync(path.join(tmpRepo, '.vibecode', 'config.yaml'), 'utf8');
    expect(localConfig).not.toContain(SECRET);
  });

  test('config sync requires an explicit direction', () => {
    const result = runCli(['config', 'sync', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('SYNC_DIRECTION_REQUIRED');
  });

  test('config sync rejects --to-global even with --from-global (disabled takes priority)', () => {
    const result = runCli(['config', 'sync', '--from-global', '--to-global', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('CONFIG_SYNC_TO_GLOBAL_DISABLED');
  });

  test('prompt --flash-provider/--flash-model with no key fails with auth error and never prints keys', () => {
    const appData = makeAppData(true, false); // config but no .env key
    cleanup.push(appData);
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# fixture\n', 'utf8');

    const result = runCli(
      ['prompt', 'manual missing auth check', '--repo', tmpRepo, '--live', '--flash-provider', 'openrouter', '--flash-model', 'deepseek/deepseek-chat', '--json'],
      tmpRepo,
      appData,
    );
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('FLASH_PROVIDER_AUTH_MISSING');
    expect(result.stdout).not.toContain(SECRET);
  });
});
