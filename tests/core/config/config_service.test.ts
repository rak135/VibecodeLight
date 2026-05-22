import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveFlashConfig,
  ensureLocalConfig,
  syncConfig,
  writeConfigResolution,
} from '../../../src/core/config/config_service.js';

const SECRET = 'sk-do-not-leak-1234567890';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeYaml(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

describe('resolveFlashConfig', () => {
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

  test('local config has priority over global config', () => {
    writeYaml(globalConfigPath, ['models:', '  flash_provider: "global-provider"', '  flash_model: "global-model"', '  flash_base_url: "https://global.example.com/v1"']);
    writeYaml(localConfigPath, ['models:', '  flash_provider: "local-provider"', '  flash_model: "local-model"']);

    const { resolution } = resolve();
    expect(resolution.provider).toBe('local-provider');
    expect(resolution.model).toBe('local-model');
    expect(resolution.source_map.provider).toBe('local');
    // base url only present in global, so it falls through
    expect(resolution.baseUrl_host).toBe('global.example.com');
    expect(resolution.source_map.baseUrl).toBe('global');
    expect(resolution.selected_config_source).toBe('mixed');
  });

  test('AppData .env participates in provider config resolution', () => {
    writeYaml(globalEnvPath, ['VIBECODE_FLASH_PROVIDER=env-provider', 'VIBECODE_FLASH_BASE_URL=https://env.example.com/v1', `VIBECODE_FLASH_API_KEY=${SECRET}`]);

    const { resolution, providerConfig } = resolve();
    expect(resolution.provider).toBe('env-provider');
    expect(resolution.source_map.provider).toBe('env');
    expect(resolution.baseUrl_host).toBe('env.example.com');
    expect(providerConfig?.provider).toBe('env-provider');
    expect(providerConfig?.baseUrl).toBe('https://env.example.com/v1');
  });

  test('CLI flags override local, global and env', () => {
    writeYaml(globalConfigPath, ['models:', '  flash_provider: "global-provider"']);
    writeYaml(localConfigPath, ['models:', '  flash_provider: "local-provider"']);
    writeYaml(globalEnvPath, ['VIBECODE_FLASH_PROVIDER=env-provider', 'VIBECODE_FLASH_MODEL=env-model']);

    const { resolution } = resolve({
      repoRoot: path.join(root, 'repo'),
      cliFlags: { provider: 'cli-provider', model: 'cli-model' },
    });
    expect(resolution.provider).toBe('cli-provider');
    expect(resolution.model).toBe('cli-model');
    expect(resolution.source_map.provider).toBe('cli');
    expect(resolution.source_map.model).toBe('cli');
  });

  test('API key source can be AppData .env', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "p"', '  flash_base_url: "https://p.example.com/v1"']);
    writeYaml(globalEnvPath, [`VIBECODE_FLASH_API_KEY=${SECRET}`]);

    const { resolution, providerConfig, error } = resolve();
    expect(error).toBeUndefined();
    expect(resolution.has_api_key).toBe(true);
    expect(resolution.source_map.apiKey).toBe('env');
    expect(providerConfig?.apiKey).toBe(SECRET);
  });

  test('API key value is never included in the resolution object', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "p"', '  flash_base_url: "https://p.example.com/v1"']);
    writeYaml(globalEnvPath, [`VIBECODE_FLASH_API_KEY=${SECRET}`]);

    const { resolution } = resolve();
    expect(JSON.stringify(resolution)).not.toContain(SECRET);
    expect(resolution).not.toHaveProperty('apiKey');
  });

  test('API key value is never written to config_resolution.json', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "p"', '  flash_base_url: "https://p.example.com/v1"']);
    writeYaml(globalEnvPath, [`VIBECODE_FLASH_API_KEY=${SECRET}`]);

    const runDir = path.join(root, 'repo', '.vibecode', 'runs', 'r1');
    const { resolution } = resolve();
    const artifactPath = writeConfigResolution(runDir, resolution);
    const written = fs.readFileSync(artifactPath, 'utf8');
    expect(written).not.toContain(SECRET);
    expect(path.basename(artifactPath)).toBe('config_resolution.json');
  });

  test('records baseUrl host only, never a credentialed URL', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "p"', '  flash_base_url: "https://user:pass@host.example.com/v1"']);
    writeYaml(globalEnvPath, [`VIBECODE_FLASH_API_KEY=${SECRET}`]);

    const { resolution } = resolve();
    expect(resolution.baseUrl_host).toBe('host.example.com');
    expect(JSON.stringify(resolution)).not.toContain('pass');
  });

  test('missing provider yields FLASH_PROVIDER_NOT_CONFIGURED', () => {
    const { error, providerConfig } = resolve();
    expect(providerConfig).toBeNull();
    expect(error?.code).toBe('FLASH_PROVIDER_NOT_CONFIGURED');
  });

  test('provider configured without api key yields FLASH_PROVIDER_AUTH_MISSING', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "p"', '  flash_base_url: "https://p.example.com/v1"']);
    const { error } = resolve();
    expect(error?.code).toBe('FLASH_PROVIDER_AUTH_MISSING');
  });

  test('ignores and warns about secret keys found in YAML config', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "p"', '  flash_base_url: "https://p.example.com/v1"', `  flash_api_key: "${SECRET}"`]);
    writeYaml(globalEnvPath, [`VIBECODE_FLASH_API_KEY=${SECRET}`]);

    const { resolution } = resolve();
    expect(resolution.warnings.join(' ')).toMatch(/flash_api_key/);
    // The secret value itself must not leak into the resolution warnings/object
    expect(JSON.stringify(resolution)).not.toContain(SECRET);
  });

  test('mock resolution records provider mock without a secret', () => {
    writeYaml(globalEnvPath, [`VIBECODE_FLASH_API_KEY=${SECRET}`]);
    const { resolution, providerConfig } = resolve({ repoRoot: path.join(root, 'repo'), mock: true });
    expect(providerConfig).toBeNull();
    expect(resolution.provider).toBe('mock');
    expect(resolution.has_api_key).toBe(false);
    expect(JSON.stringify(resolution)).not.toContain(SECRET);
  });

  test('records existence of global/local config and env', () => {
    writeYaml(globalConfigPath, ['models:', '  flash_provider: "g"']);
    writeYaml(globalEnvPath, ['VIBECODE_FLASH_API_KEY=x']);
    const { resolution } = resolve();
    expect(resolution.global_config_exists).toBe(true);
    expect(resolution.global_env_exists).toBe(true);
    expect(resolution.local_config_exists).toBe(false);
    expect(resolution.global_config_path).toBe(globalConfigPath);
    expect(resolution.global_env_path).toBe(globalEnvPath);
    expect(resolution.local_config_path).toBe(localConfigPath);
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
    writeYaml(globalConfigPath, ['models:', '  flash_provider: "global-provider"', '  flash_model: "global-model"']);

    const result = ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.created).toBe(true);
    expect(result.createdFromGlobal).toBe(true);
    expect(result.source).toBe('global-snapshot');
    expect(fs.existsSync(localConfigPath)).toBe(true);
    expect(fs.readFileSync(localConfigPath, 'utf8')).toContain('global-provider');
  });

  test('creates a minimal local config when global does not exist', () => {
    const result = ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.created).toBe(true);
    expect(result.createdFromGlobal).toBe(false);
    expect(result.source).toBe('defaults');
    expect(fs.existsSync(localConfigPath)).toBe(true);
  });

  test('does not overwrite an existing local config without explicit sync', () => {
    writeYaml(globalConfigPath, ['models:', '  flash_provider: "global-provider"']);
    writeYaml(localConfigPath, ['models:', '  flash_provider: "local-keep-me"']);
    const before = fs.readFileSync(localConfigPath, 'utf8');

    const result = ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.created).toBe(false);
    expect(result.alreadyExisted).toBe(true);
    expect(result.source).toBe('existing');
    expect(fs.readFileSync(localConfigPath, 'utf8')).toBe(before);
  });

  test('snapshot from global strips secret keys', () => {
    writeYaml(globalConfigPath, ['models:', '  flash_provider: "g"', `  flash_api_key: "${SECRET}"`]);
    ensureLocalConfig({ repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(fs.readFileSync(localConfigPath, 'utf8')).not.toContain(SECRET);
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

  test('from-global copies global config to local and reports paths', () => {
    writeYaml(globalConfigPath, ['models:', '  flash_provider: "from-global"']);
    const result = syncConfig({ direction: 'from-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.ok).toBe(true);
    expect(result.sourcePath).toBe(globalConfigPath);
    expect(result.destinationPath).toBe(localConfigPath);
    expect(fs.readFileSync(localConfigPath, 'utf8')).toContain('from-global');
  });

  test('to-global copies local config to global and reports paths', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "from-local"']);
    const result = syncConfig({ direction: 'to-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.ok).toBe(true);
    expect(result.sourcePath).toBe(localConfigPath);
    expect(result.destinationPath).toBe(globalConfigPath);
    expect(fs.readFileSync(globalConfigPath, 'utf8')).toContain('from-local');
  });

  test('from-global fails clearly when global config is absent', () => {
    const result = syncConfig({ direction: 'from-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GLOBAL_CONFIG_NOT_FOUND');
  });

  test('to-global only writes the global side (does not touch local)', () => {
    writeYaml(localConfigPath, ['models:', '  flash_provider: "from-local"']);
    const before = fs.readFileSync(localConfigPath, 'utf8');
    syncConfig({ direction: 'to-global', repoRoot: path.join(root, 'repo'), globalConfigPath, localConfigPath });
    expect(fs.readFileSync(localConfigPath, 'utf8')).toBe(before);
  });
});
