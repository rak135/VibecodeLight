import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import YAML from 'yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

const SECRET = 'sk-cli-secret-should-never-print';

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
    expect(fs.readFileSync(path.join(tmpRepo, '.vibecode', 'config.yaml'), 'utf8')).toContain('openrouter');
  });

  test('config sync --to-global copies the local registry to global', () => {
    const appData = makeAppData(false, false);
    cleanup.push(appData);
    const localPath = path.join(tmpRepo, '.vibecode', 'config.yaml');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, YAML.stringify({ providers: { localhost: { type: 'openai-compatible', base_url: 'https://local.invalid', api_key_env: 'LOCAL_KEY', models: [] } }, defaults: { flash: { provider: 'localhost' } } }), 'utf8');

    const result = runCli(['config', 'sync', '--to-global', '--repo', tmpRepo, '--json'], tmpRepo, appData);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data.direction).toBe('to-global');
    expect(fs.readFileSync(path.join(appData, 'vibecodelight', 'config.yaml'), 'utf8')).toContain('localhost');
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

  test('config sync rejects both directions at once', () => {
    const result = runCli(['config', 'sync', '--from-global', '--to-global', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('SYNC_DIRECTION_REQUIRED');
  });

  test('prompt --flash-provider/--flash-model with no key fails with auth error and never prints keys', () => {
    const appData = makeAppData(true, false); // config but no .env key
    cleanup.push(appData);
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# fixture\n', 'utf8');

    const result = runCli(
      ['prompt', 'manual missing auth check', '--repo', tmpRepo, '--flash-provider', 'openrouter', '--flash-model', 'deepseek/deepseek-chat', '--json'],
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
