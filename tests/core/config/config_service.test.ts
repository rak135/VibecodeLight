import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';

import {
  resolveFlashConfig,
  ensureLocalConfig,
  syncConfig,
  writeConfigResolution,
} from '../../../src/core/config/config_service.js';

const SECRET = 'sk-do-not-leak-1234567890';

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
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat', role: 'flash' },
        { id: 'deepseek-reasoner', role: 'flash' },
      ],
    },
  },
  defaults: {
    flash: { provider: 'openrouter', model: 'deepseek/deepseek-chat', timeout_ms: 30000, max_tokens: 4096, temperature: 0.1 },
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeYaml(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(obj), 'utf8');
}

function writeEnv(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

describe('resolveFlashConfig (provider registry)', () => {
  let root: string;
  let globalConfigPath: string;
  let globalEnvPath: string;
  let localConfigPath: string;

  beforeEach(() => {
    root = tmp('vibecode-cfg-');
    globalConfigPath = path.join(root, 'global', 'config.yaml');
    globalEnvPath = path.join(root, 'global', '.env');
    localConfigPath = path.join(root, 'repo', '.vibecode', 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function resolve(extra: Partial<Parameters<typeof resolveFlashConfig>[0]> = {}) {
    return resolveFlashConfig({
      repoRoot: path.join(root, 'repo'),
      env: {},
      globalConfigPath,
      globalEnvPath,
      localConfigPath,
      ...extra,
    });
  }

  test('parses the new provider registry config and selects default flash provider/model from local config', () => {
    writeYaml(localConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);

    const { resolution, providerConfig, error } = resolve();
    expect(error).toBeUndefined();
    expect(resolution.provider).toBe('openrouter');
    expect(resolution.provider_label).toBe('OpenRouter');
    expect(resolution.provider_type).toBe('openai-compatible');
    expect(resolution.model).toBe('deepseek/deepseek-chat');
    expect(resolution.model_label).toBe('DeepSeek Chat via OpenRouter');
    expect(resolution.source_map.provider).toBe('local');
    expect(resolution.source_map.model).toBe('local');
    expect(resolution.selected_config_source).toBe('local');
    expect(resolution.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(resolution.has_api_key).toBe(true);
    expect(resolution.api_key_source).toBe('global-env:OPENROUTER_API_KEY');
    expect(resolution.baseUrl_host).toBe('openrouter.ai');
    expect(providerConfig?.provider).toBe('openrouter');
    expect(providerConfig?.apiKey).toBe(SECRET);
    expect(providerConfig?.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(providerConfig?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(providerConfig?.model).toBe('deepseek/deepseek-chat');
    expect(providerConfig?.timeoutMs).toBe(30000);
    expect(providerConfig?.maxTokens).toBe(4096);
    expect(providerConfig?.temperature).toBe(0.1);
  });

  test('local config overrides global config', () => {
    writeYaml(globalConfigPath, REGISTRY);
    writeYaml(localConfigPath, { defaults: { flash: { provider: 'deepseek', model: 'deepseek-chat' } } });
    writeEnv(globalEnvPath, [`DEEPSEEK_API_KEY=${SECRET}`]);

    const { resolution } = resolve();
    expect(resolution.provider).toBe('deepseek');
    expect(resolution.model).toBe('deepseek-chat');
    expect(resolution.source_map.provider).toBe('local');
    expect(resolution.source_map.model).toBe('local');
    // base url comes from the global provider entry
    expect(resolution.baseUrl_host).toBe('api.deepseek.com');
    expect(resolution.source_map.baseUrl).toBe('global');
    expect(resolution.selected_config_source).toBe('mixed');
    expect(resolution.api_key_env).toBe('DEEPSEEK_API_KEY');
  });

  test('global config is used when local config is missing', () => {
    writeYaml(globalConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);

    const { resolution } = resolve();
    expect(resolution.provider).toBe('openrouter');
    expect(resolution.source_map.provider).toBe('global');
    expect(resolution.selected_config_source).toBe('global');
  });

  test('CLI flags override local and global defaults', () => {
    writeYaml(globalConfigPath, REGISTRY);
    writeYaml(localConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`DEEPSEEK_API_KEY=${SECRET}`]);

    const { resolution } = resolve({ cliFlags: { provider: 'deepseek', model: 'deepseek-reasoner' } });
    expect(resolution.provider).toBe('deepseek');
    expect(resolution.model).toBe('deepseek-reasoner');
    expect(resolution.source_map.provider).toBe('cli');
    expect(resolution.source_map.model).toBe('cli');
  });

  test('OPENROUTER_API_KEY is used for the openrouter provider', () => {
    writeYaml(localConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);

    const { resolution, providerConfig } = resolve();
    expect(resolution.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(resolution.has_api_key).toBe(true);
    expect(providerConfig?.apiKey).toBe(SECRET);
  });

  test('DEEPSEEK_API_KEY is used for the deepseek provider', () => {
    writeYaml(localConfigPath, clone(REGISTRY));
    // select deepseek via CLI
    writeEnv(globalEnvPath, [`DEEPSEEK_API_KEY=${SECRET}`]);

    const { resolution, providerConfig } = resolve({ cliFlags: { provider: 'deepseek', model: 'deepseek-chat' } });
    expect(resolution.api_key_env).toBe('DEEPSEEK_API_KEY');
    expect(resolution.has_api_key).toBe(true);
    expect(providerConfig?.apiKey).toBe(SECRET);
    expect(providerConfig?.baseUrl).toBe('https://api.deepseek.com');
  });

  test('missing provider api_key_env fails with PROVIDER_API_KEY_ENV_MISSING', () => {
    writeYaml(localConfigPath, {
      providers: { noenv: { type: 'openai-compatible', base_url: 'https://noenv.invalid/v1', models: [{ id: 'm1', role: 'flash' }] } },
      defaults: { flash: { provider: 'noenv', model: 'm1' } },
    });

    const { error, providerConfig } = resolve();
    expect(providerConfig).toBeNull();
    expect(error?.code).toBe('PROVIDER_API_KEY_ENV_MISSING');
  });

  test('configured api_key_env with no value fails with FLASH_PROVIDER_AUTH_MISSING', () => {
    writeYaml(localConfigPath, REGISTRY);
    // no .env at all → OPENROUTER_API_KEY value missing
    const { error } = resolve();
    expect(error?.code).toBe('FLASH_PROVIDER_AUTH_MISSING');
  });

  test('selecting a provider not in the registry fails with CONFIG_PROVIDER_NOT_FOUND', () => {
    writeYaml(localConfigPath, { providers: REGISTRY.providers, defaults: { flash: { provider: 'ghost', model: 'x' } } });
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);

    const { error } = resolve();
    expect(error?.code).toBe('CONFIG_PROVIDER_NOT_FOUND');
  });

  test('selecting a model not in the provider fails with CONFIG_MODEL_NOT_FOUND', () => {
    writeYaml(localConfigPath, { providers: REGISTRY.providers, defaults: { flash: { provider: 'openrouter', model: 'ghost-model' } } });
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);

    const { error } = resolve();
    expect(error?.code).toBe('CONFIG_MODEL_NOT_FOUND');
  });

  test('no provider configured yields FLASH_PROVIDER_NOT_CONFIGURED', () => {
    writeYaml(localConfigPath, { version: 1 });
    const { error, providerConfig } = resolve();
    expect(providerConfig).toBeNull();
    expect(error?.code).toBe('FLASH_PROVIDER_NOT_CONFIGURED');
  });

  test('provider with no model selected yields FLASH_MODEL_NOT_CONFIGURED', () => {
    writeYaml(localConfigPath, { providers: REGISTRY.providers, defaults: { flash: { provider: 'openrouter' } } });
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);

    const { error } = resolve();
    expect(error?.code).toBe('FLASH_MODEL_NOT_CONFIGURED');
  });

  test('rejects an invalid provider registry with CONFIG_INVALID_PROVIDER_REGISTRY', () => {
    writeYaml(localConfigPath, { providers: 'not-an-object' });
    const { error, providerConfig } = resolve();
    expect(providerConfig).toBeNull();
    expect(error?.code).toBe('CONFIG_INVALID_PROVIDER_REGISTRY');
  });

  test('API key value is never included in the resolution object', () => {
    writeYaml(localConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);
    const { resolution } = resolve();
    expect(JSON.stringify(resolution)).not.toContain(SECRET);
    expect(resolution).not.toHaveProperty('apiKey');
  });

  test('API key value is never written to config_resolution.json', () => {
    writeYaml(localConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);
    const runDir = path.join(root, 'repo', '.vibecode', 'runs', 'r1');
    const { resolution } = resolve();
    const artifactPath = writeConfigResolution(runDir, resolution);
    const written = fs.readFileSync(artifactPath, 'utf8');
    expect(written).not.toContain(SECRET);
    expect(path.basename(artifactPath)).toBe('config_resolution.json');
  });

  test('records baseUrl host only, never a credentialed URL', () => {
    writeYaml(localConfigPath, {
      providers: { p: { type: 'openai-compatible', base_url: 'https://user:pass@host.example.com/v1', api_key_env: 'P_KEY', models: [{ id: 'm', role: 'flash' }] } },
      defaults: { flash: { provider: 'p', model: 'm' } },
    });
    writeEnv(globalEnvPath, [`P_KEY=${SECRET}`]);

    const { resolution } = resolve();
    expect(resolution.baseUrl_host).toBe('host.example.com');
    expect(JSON.stringify(resolution)).not.toContain('pass');
  });

  test('mock resolution records provider mock without a secret', () => {
    writeYaml(localConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);
    const { resolution, providerConfig } = resolve({ mock: true });
    expect(providerConfig).toBeNull();
    expect(resolution.provider).toBe('mock');
    expect(resolution.has_api_key).toBe(false);
    expect(JSON.stringify(resolution)).not.toContain(SECRET);
  });

  test('records existence of global/local config and env paths', () => {
    writeYaml(globalConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);
    const { resolution } = resolve();
    expect(resolution.global_config_exists).toBe(true);
    expect(resolution.global_env_exists).toBe(true);
    expect(resolution.local_config_exists).toBe(false);
    expect(resolution.global_config_path).toBe(globalConfigPath);
    expect(resolution.global_env_path).toBe(globalEnvPath);
    expect(resolution.local_config_path).toBe(localConfigPath);
  });

  test('ignores and warns about secret keys found in YAML config', () => {
    writeYaml(localConfigPath, {
      providers: { openrouter: { type: 'openai-compatible', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY', api_key: SECRET, models: [{ id: 'm', role: 'flash' }] } },
      defaults: { flash: { provider: 'openrouter', model: 'm' } },
    });
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]);

    const { resolution } = resolve();
    expect(resolution.warnings.join(' ')).toMatch(/api_key/);
    expect(JSON.stringify(resolution)).not.toContain(SECRET);
  });

  test('lists all configured providers with models and per-provider has_api_key', () => {
    writeYaml(globalConfigPath, REGISTRY);
    writeEnv(globalEnvPath, [`OPENROUTER_API_KEY=${SECRET}`]); // only openrouter has a key

    const { resolution } = resolve();
    const openrouter = resolution.providers.find((p) => p.id === 'openrouter');
    const deepseek = resolution.providers.find((p) => p.id === 'deepseek');
    expect(openrouter?.has_api_key).toBe(true);
    expect(openrouter?.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(openrouter?.models.map((m) => m.id)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner']);
    expect(deepseek?.has_api_key).toBe(false);
    expect(JSON.stringify(resolution.providers)).not.toContain(SECRET);
  });

  test('legacy models.flash_* config still resolves with a deprecation warning', () => {
    writeYaml(localConfigPath, { models: { flash_provider: 'legacyhost', flash_model: 'legacy-model', flash_base_url: 'https://legacy.invalid/v1' } });
    writeEnv(globalEnvPath, [`VIBECODE_FLASH_API_KEY=${SECRET}`]);

    const { resolution, providerConfig, error } = resolve();
    expect(error).toBeUndefined();
    expect(resolution.provider).toBe('legacyhost');
    expect(resolution.api_key_env).toBe('VIBECODE_FLASH_API_KEY');
    expect(resolution.has_api_key).toBe(true);
    expect(resolution.warnings.join(' ')).toMatch(/deprecat/i);
    expect(providerConfig?.apiKey).toBe(SECRET);
  });
});

describe('ensureLocalConfig', () => {
  let root: string;
  let globalConfigPath: string;
  let localConfigPath: string;

  beforeEach(() => {
    root = tmp('vibecode-ensure-');
    globalConfigPath = path.join(root, 'global', 'config.yaml');
    localConfigPath = path.join(root, 'repo', '.vibecode', 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates local config from global when local is missing', () => {
    writeYaml(globalConfigPath, REGISTRY);

    const result = ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.created).toBe(true);
    expect(result.createdFromGlobal).toBe(true);
    expect(result.source).toBe('global-snapshot');
    expect(fs.existsSync(localConfigPath)).toBe(true);
    expect(fs.readFileSync(localConfigPath, 'utf8')).toContain('openrouter');
  });

  test('creates a minimal local config when global does not exist', () => {
    const result = ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.created).toBe(true);
    expect(result.createdFromGlobal).toBe(false);
    expect(result.source).toBe('defaults');
    expect(fs.existsSync(localConfigPath)).toBe(true);
    // minimal config must be a valid registry shape (parseable, no providers)
    const parsed = YAML.parse(fs.readFileSync(localConfigPath, 'utf8'));
    expect(parsed).toHaveProperty('providers');
  });

  test('does not overwrite an existing local config without explicit sync', () => {
    writeYaml(globalConfigPath, REGISTRY);
    writeYaml(localConfigPath, { defaults: { flash: { provider: 'local-keep-me' } } });
    const before = fs.readFileSync(localConfigPath, 'utf8');

    const result = ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.created).toBe(false);
    expect(result.alreadyExisted).toBe(true);
    expect(result.source).toBe('existing');
    expect(fs.readFileSync(localConfigPath, 'utf8')).toBe(before);
  });

  test('snapshot from global strips secret keys but keeps api_key_env', () => {
    writeYaml(globalConfigPath, {
      providers: { openrouter: { type: 'openai-compatible', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_API_KEY', api_key: SECRET, models: [] } },
      defaults: { flash: { provider: 'openrouter' } },
    });
    ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    const written = fs.readFileSync(localConfigPath, 'utf8');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('api_key_env');
  });
});

describe('syncConfig', () => {
  let root: string;
  let globalConfigPath: string;
  let localConfigPath: string;

  beforeEach(() => {
    root = tmp('vibecode-sync-');
    globalConfigPath = path.join(root, 'global', 'config.yaml');
    localConfigPath = path.join(root, 'repo', '.vibecode', 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('from-global copies the provider registry shape to local and reports paths', () => {
    writeYaml(globalConfigPath, REGISTRY);
    const result = syncConfig({ direction: 'from-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.ok).toBe(true);
    expect(result.sourcePath).toBe(globalConfigPath);
    expect(result.destinationPath).toBe(localConfigPath);
    expect(fs.readFileSync(localConfigPath, 'utf8')).toContain('openrouter');
  });

  test('to-global copies the provider registry shape to global and reports paths', () => {
    writeYaml(localConfigPath, REGISTRY);
    const result = syncConfig({ direction: 'to-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.ok).toBe(true);
    expect(result.sourcePath).toBe(localConfigPath);
    expect(result.destinationPath).toBe(globalConfigPath);
    expect(fs.readFileSync(globalConfigPath, 'utf8')).toContain('openrouter');
  });

  test('from-global fails clearly when global config is absent', () => {
    const result = syncConfig({ direction: 'from-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GLOBAL_CONFIG_NOT_FOUND');
  });

  test('to-global only writes the global side (does not touch local)', () => {
    writeYaml(localConfigPath, REGISTRY);
    const before = fs.readFileSync(localConfigPath, 'utf8');
    syncConfig({ direction: 'to-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(fs.readFileSync(localConfigPath, 'utf8')).toBe(before);
  });
});
