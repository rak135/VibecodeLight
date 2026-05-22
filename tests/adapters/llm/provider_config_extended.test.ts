import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadProviderConfig, loadProviderConfigFromYaml } from '../../../src/adapters/llm/provider_config.js';

describe('provider_config extended', () => {
  const originalEnv = { ...process.env };
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-provider-config-'));
    process.env = { ...originalEnv };
    delete process.env.VIBECODE_PROVIDER;
    delete process.env.VIBECODE_API_KEY;
    delete process.env.VIBECODE_MODEL;
    delete process.env.VIBECODE_BASE_URL;
    delete process.env.VIBECODE_FLASH_PROVIDER;
    delete process.env.VIBECODE_FLASH_API_KEY;
    delete process.env.VIBECODE_FLASH_MODEL;
    delete process.env.VIBECODE_FLASH_BASE_URL;
    delete process.env.VIBECODE_FLASH_TIMEOUT_MS;
    delete process.env.VIBECODE_FLASH_MAX_TOKENS;
    delete process.env.VIBECODE_FLASH_TEMPERATURE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('loadProviderConfigFromYaml reads flash provider and model from config.yaml', () => {
    const configYamlPath = path.join(tmpRoot, 'config.yaml');
    fs.writeFileSync(
      configYamlPath,
      ['models:', '  flash_provider: "yaml-provider"', '  flash_model: "yaml-model"'].join('\n'),
      'utf8',
    );

    expect(loadProviderConfigFromYaml(configYamlPath)).toEqual({
      provider: 'yaml-provider',
      model: 'yaml-model',
    });
  });

  test('config.yaml provider and model override legacy env vars while flash env still supplies api key and base url', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config.yaml'),
      ['models:', '  flash_provider: "yaml-provider"', '  flash_model: "yaml-model"'].join('\n'),
      'utf8',
    );

    process.env.VIBECODE_PROVIDER = 'legacy-provider';
    process.env.VIBECODE_API_KEY = 'legacy-api-key';
    process.env.VIBECODE_MODEL = 'legacy-model';
    process.env.VIBECODE_BASE_URL = 'https://legacy.example.invalid/v1';
    process.env.VIBECODE_FLASH_PROVIDER = 'flash-provider';
    process.env.VIBECODE_FLASH_API_KEY = 'flash-api-key';
    process.env.VIBECODE_FLASH_MODEL = 'flash-model';
    process.env.VIBECODE_FLASH_BASE_URL = 'https://flash.example.invalid/v1';

    expect(loadProviderConfig(process.env, { workspaceRoot: tmpRoot })).toEqual({
      provider: 'yaml-provider',
      apiKey: 'flash-api-key',
      model: 'yaml-model',
      baseUrl: 'https://flash.example.invalid/v1',
      live: false,
    });
  });

  test('VIBECODE_FLASH_PROVIDER overrides VIBECODE_PROVIDER when no config.yaml provider is set', () => {
    process.env.VIBECODE_PROVIDER = 'legacy-provider';
    process.env.VIBECODE_API_KEY = 'legacy-api-key';
    process.env.VIBECODE_MODEL = 'legacy-model';
    process.env.VIBECODE_BASE_URL = 'https://legacy.example.invalid/v1';
    process.env.VIBECODE_FLASH_PROVIDER = 'flash-provider';
    process.env.VIBECODE_FLASH_API_KEY = 'flash-api-key';
    process.env.VIBECODE_FLASH_MODEL = 'flash-model';
    process.env.VIBECODE_FLASH_BASE_URL = 'https://flash.example.invalid/v1';
    process.env.VIBECODE_FLASH_TIMEOUT_MS = '42';
    process.env.VIBECODE_FLASH_MAX_TOKENS = '1234';
    process.env.VIBECODE_FLASH_TEMPERATURE = '0.25';

    expect(loadProviderConfig(process.env, { workspaceRoot: tmpRoot })).toEqual({
      provider: 'flash-provider',
      apiKey: 'flash-api-key',
      model: 'flash-model',
      baseUrl: 'https://flash.example.invalid/v1',
      timeoutMs: 42,
      maxTokens: 1234,
      temperature: 0.25,
      live: false,
    });
  });

  test('returns null when provider is configured but apiKey is missing or provider is mock', () => {
    process.env.VIBECODE_FLASH_PROVIDER = 'openrouter';
    process.env.VIBECODE_FLASH_BASE_URL = 'https://api.example.invalid/v1';

    expect(loadProviderConfig(process.env, { workspaceRoot: tmpRoot })).toBeNull();

    process.env.VIBECODE_FLASH_PROVIDER = 'mock';
    process.env.VIBECODE_FLASH_API_KEY = 'not-needed';

    expect(loadProviderConfig(process.env, { workspaceRoot: tmpRoot })).toBeNull();
  });
});
