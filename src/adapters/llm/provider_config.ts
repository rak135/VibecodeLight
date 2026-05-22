import fs from 'fs';

import YAML from 'yaml';

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  live: boolean;
}

interface ConfigYamlModels {
  flash_provider?: string;
  flash_model?: string;
}

interface ConfigYaml {
  models?: ConfigYamlModels;
}

export function loadProviderConfigFromYaml(configYamlPath: string): Partial<Pick<ProviderConfig, 'provider' | 'model'>> {
  if (!fs.existsSync(configYamlPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(configYamlPath, 'utf8');
    const parsed = YAML.parse(raw) as ConfigYaml | null;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const models = parsed.models;
    if (!models) {
      return {};
    }
    const result: Partial<Pick<ProviderConfig, 'provider' | 'model'>> = {};
    const p = models.flash_provider?.trim();
    const m = models.flash_model?.trim();
    if (p) result.provider = p;
    if (m) result.model = m;
    return result;
  } catch {
    return {};
  }
}

export function loadProviderConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { live?: boolean; workspaceRoot?: string } = {},
): ProviderConfig | null {
  // Resolve from config.yaml (lowest priority among named sources, but overrides legacy env)
  let yamlConfig: Partial<Pick<ProviderConfig, 'provider' | 'model'>> = {};
  if (opts.workspaceRoot) {
    const configYamlPath = `${opts.workspaceRoot}/config.yaml`;
    yamlConfig = loadProviderConfigFromYaml(configYamlPath);
  }

  // Priority: VIBECODE_FLASH_* env > VIBECODE_* (legacy) env
  const flashProvider = env.VIBECODE_FLASH_PROVIDER?.trim();
  const flashApiKey = env.VIBECODE_FLASH_API_KEY?.trim();
  const flashModel = env.VIBECODE_FLASH_MODEL?.trim();
  const flashBaseUrl = env.VIBECODE_FLASH_BASE_URL?.trim();
  const flashTimeoutMs = env.VIBECODE_FLASH_TIMEOUT_MS?.trim();
  const flashMaxTokens = env.VIBECODE_FLASH_MAX_TOKENS?.trim();
  const flashTemperature = env.VIBECODE_FLASH_TEMPERATURE?.trim();

  const legacyProvider = env.VIBECODE_PROVIDER?.trim();
  const legacyApiKey = env.VIBECODE_API_KEY?.trim();
  const legacyModel = env.VIBECODE_MODEL?.trim();
  const legacyBaseUrl = env.VIBECODE_BASE_URL?.trim();

  // Merge: config.yaml > VIBECODE_FLASH_* > legacy VIBECODE_*
  const provider = yamlConfig.provider || flashProvider || legacyProvider;
  const apiKey = flashApiKey || legacyApiKey;
  const model = yamlConfig.model || flashModel || legacyModel;
  const baseUrl = flashBaseUrl || legacyBaseUrl;

  // If no provider at all, return null
  if (!provider) {
    return null;
  }

  // 'mock' provider string via env is not a live provider; mock mode is --mock flag only
  if (provider === 'mock') {
    return null;
  }

  // Provider configured but apiKey missing → cannot configure
  if (!apiKey) {
    return null;
  }

  const config: ProviderConfig = {
    provider,
    apiKey,
    live: opts.live ?? false,
  };

  if (model) config.model = model;
  if (baseUrl) config.baseUrl = baseUrl;
  if (flashTimeoutMs) {
    const n = parseInt(flashTimeoutMs, 10);
    if (!isNaN(n)) config.timeoutMs = n;
  }
  if (flashMaxTokens) {
    const n = parseInt(flashMaxTokens, 10);
    if (!isNaN(n)) config.maxTokens = n;
  }
  if (flashTemperature) {
    const n = parseFloat(flashTemperature);
    if (!isNaN(n)) config.temperature = n;
  }

  return config;
}
