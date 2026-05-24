import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import type { ProviderConfig } from '../../adapters/llm/provider_config.js';
import { loadEnvFile } from './env_file.js';
import {
  isSecretKey,
  mergeRegistries,
  parseRegistryObject,
  safeHost,
  type MergedRegistry,
  type ParsedRegistry,
  type ProviderEntry,
} from './provider_registry.js';
import { getGlobalConfigPaths, getLocalConfigPath } from './user_profile.js';

export type FieldSource = 'cli' | 'local' | 'global' | 'env' | 'process-env' | 'default' | 'none';
export type SelectedConfigSource = 'local' | 'global' | 'cli' | 'mixed' | 'default';

export type ConfigErrorCode =
  | 'FLASH_PROVIDER_NOT_CONFIGURED'
  | 'FLASH_MODEL_NOT_CONFIGURED'
  | 'CONFIG_PROVIDER_NOT_FOUND'
  | 'CONFIG_MODEL_NOT_FOUND'
  | 'PROVIDER_API_KEY_ENV_MISSING'
  | 'FLASH_PROVIDER_AUTH_MISSING'
  | 'CONFIG_INVALID_PROVIDER_REGISTRY';

export interface ConfigSourceMap {
  provider: FieldSource;
  model: FieldSource;
  baseUrl: FieldSource;
  timeout: FieldSource;
  maxTokens: FieldSource;
  temperature: FieldSource;
  /** Source of the API key only — the value is never recorded. */
  apiKey: FieldSource;
}

export interface ProviderModelSummary {
  id: string;
  label: string | null;
  role: string | null;
}

/** Safe, secret-free summary of one configured provider (no API key values). */
export interface ProviderSummary {
  id: string;
  label: string | null;
  type: string | null;
  /** Host only — never a full URL. */
  baseUrl_host: string | null;
  /** The NAME of the env variable that would hold the key, never the value. */
  api_key_env: string | null;
  /** Whether a value for api_key_env was found in the env. */
  has_api_key: boolean;
  /** Which config file defined this provider entry. */
  origin: 'local' | 'global';
  models: ProviderModelSummary[];
}

/** Safe, secret-free description of how a flash run's config was resolved. */
export interface ConfigResolution {
  global_config_path: string;
  global_env_path: string;
  local_config_path: string;
  global_config_exists: boolean;
  global_env_exists: boolean;
  local_config_exists: boolean;
  local_config_created_from_global: boolean;
  selected_config_source: SelectedConfigSource;
  /** Whether this resolution is for a live or mock flash run. */
  flash_mode: 'mock' | 'live';
  provider: string | null;
  provider_label: string | null;
  provider_type: string | null;
  model: string | null;
  model_label: string | null;
  /** Host only — never a full URL that could contain credentials. */
  baseUrl_host: string | null;
  /** The NAME of the selected provider's API key env variable. Never the value. */
  api_key_env: string | null;
  /** Where the API key came from, e.g. "global-env:OPENROUTER_API_KEY". Never the value. */
  api_key_source: string | null;
  timeoutMs: number | null;
  maxTokens: number | null;
  temperature: number | null;
  /** Whether an API key was found — the value is never recorded. */
  has_api_key: boolean;
  source_map: ConfigSourceMap;
  /** All configured providers (safe; no secret values). */
  providers: ProviderSummary[];
  warnings: string[];
}

export interface CliConfigFlags {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export interface ResolveFlashConfigInput {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  cliFlags?: CliConfigFlags;
  live?: boolean;
  mock?: boolean;
  globalConfigPath?: string;
  globalEnvPath?: string;
  localConfigPath?: string;
  localCreatedFromGlobal?: boolean;
}

export interface ResolveFlashConfigResult {
  resolution: ConfigResolution;
  /** Includes the secret apiKey for adapter use. NEVER serialize this object. */
  providerConfig: ProviderConfig | null;
  error?: {
    code: ConfigErrorCode;
    message: string;
    details: string[];
  };
}

export interface ConfigPaths {
  globalDir: string;
  globalConfig: string;
  globalEnv: string;
  localConfig: string;
}

interface RegistryFileRead {
  exists: boolean;
  parsed: ParsedRegistry;
}

function readRegistryFile(filePath: string): RegistryFileRead {
  if (!fs.existsSync(filePath)) {
    return { exists: false, parsed: parseRegistryObject(null) };
  }
  let decoded: unknown;
  try {
    decoded = YAML.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    decoded = null;
  }
  return { exists: true, parsed: parseRegistryObject(decoded) };
}

function readEnvValue(
  name: string,
  dotEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): { value?: string; source: 'env' | 'process-env' } | null {
  const fromDotEnv = dotEnv[name]?.trim();
  if (fromDotEnv) return { value: fromDotEnv, source: 'env' };
  const fromProcess = processEnv[name]?.trim();
  if (fromProcess) return { value: fromProcess, source: 'process-env' };
  return null;
}

function buildProviderSummaries(
  merged: MergedRegistry,
  dotEnv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): ProviderSummary[] {
  const summaries: ProviderSummary[] = [];
  for (const { id, entry, origin } of merged.providers.values()) {
    const apiKeyEnv = entry.api_key_env ?? null;
    const hasKey = apiKeyEnv ? Boolean(readEnvValue(apiKeyEnv, dotEnv, processEnv)) : false;
    summaries.push({
      id,
      label: entry.label ?? null,
      type: entry.type ?? null,
      baseUrl_host: safeHost(entry.base_url),
      api_key_env: apiKeyEnv,
      has_api_key: hasKey,
      origin,
      models: entry.models.map((m) => ({ id: m.id, label: m.label ?? null, role: m.role ?? null })),
    });
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return summaries;
}

function aggregateSelectedSource(sources: FieldSource[]): SelectedConfigSource {
  const used = new Set<FieldSource>();
  for (const s of sources) {
    if (s === 'cli' || s === 'local' || s === 'global') used.add(s);
  }
  if (used.size === 0) return 'default';
  if (used.size === 1) return [...used][0] as SelectedConfigSource;
  return 'mixed';
}

/** Compute the global/local config path bundle for a repository. */
export function getConfigPaths(repoRoot: string, env: Record<string, string | undefined> = process.env): ConfigPaths {
  const global = getGlobalConfigPaths(env);
  return {
    globalDir: global.dir,
    globalConfig: global.config,
    globalEnv: global.env,
    localConfig: getLocalConfigPath(repoRoot),
  };
}

/**
 * Resolve the active flash provider/model from CLI flags, the local workspace
 * provider registry, and the global AppData provider registry — in that priority
 * order. The available provider/model registry comes only from config.yaml; the
 * .env file contributes only the secret value for the selected provider's
 * api_key_env.
 *
 * Returns both a safe ConfigResolution (for artifacts/diagnostics) and a
 * ProviderConfig (carrying the secret) for adapter use. Never serialize
 * providerConfig.
 */
export function resolveFlashConfig(input: ResolveFlashConfigInput): ResolveFlashConfigResult {
  const env = input.env ?? process.env;
  const cli = input.cliFlags ?? {};
  const globalPaths = getGlobalConfigPaths(env);
  const globalConfigPath = input.globalConfigPath ?? globalPaths.config;
  const globalEnvPath = input.globalEnvPath ?? globalPaths.env;
  const localConfigPath = input.localConfigPath ?? getLocalConfigPath(input.repoRoot);

  const globalRead = readRegistryFile(globalConfigPath);
  const localRead = readRegistryFile(localConfigPath);
  const dotEnv = loadEnvFile(globalEnvPath);

  const globalConfigExists = globalRead.exists;
  const globalEnvExists = fs.existsSync(globalEnvPath);
  const localConfigExists = localRead.exists;

  const warnings: string[] = [];
  for (const key of globalRead.parsed.secretKeysFound) {
    warnings.push(`ignored secret key "${key}" in global config ${globalConfigPath}; secrets must live in the AppData .env file`);
  }
  for (const key of localRead.parsed.secretKeysFound) {
    warnings.push(`ignored secret key "${key}" in local config ${localConfigPath}; secrets must live in the AppData .env file`);
  }
  if (globalRead.parsed.legacy) {
    warnings.push(`global config ${globalConfigPath} uses the deprecated models.flash_* shape; migrate to providers/defaults registry`);
  }
  if (localRead.parsed.legacy) {
    warnings.push(`local config ${localConfigPath} uses the deprecated models.flash_* shape; migrate to providers/defaults registry`);
  }

  const merged = mergeRegistries(globalRead.parsed.registry, localRead.parsed.registry);
  const providers = buildProviderSummaries(merged, dotEnv, env);

  const baseResolution = (overrides: Partial<ConfigResolution> = {}): ConfigResolution => ({
    global_config_path: globalConfigPath,
    global_env_path: globalEnvPath,
    local_config_path: localConfigPath,
    global_config_exists: globalConfigExists,
    global_env_exists: globalEnvExists,
    local_config_exists: localConfigExists,
    local_config_created_from_global: input.localCreatedFromGlobal ?? false,
    selected_config_source: 'default',
    flash_mode: input.mock ? 'mock' : 'live',
    provider: null,
    provider_label: null,
    provider_type: null,
    model: null,
    model_label: null,
    baseUrl_host: null,
    api_key_env: null,
    api_key_source: null,
    timeoutMs: null,
    maxTokens: null,
    temperature: null,
    has_api_key: false,
    source_map: {
      provider: 'none',
      model: 'none',
      baseUrl: 'none',
      timeout: 'none',
      maxTokens: 'none',
      temperature: 'none',
      apiKey: 'none',
    },
    providers,
    warnings,
    ...overrides,
  });

  // Invalid registry → fail before any selection. Local (priority) reported first.
  if (localRead.parsed.invalid || globalRead.parsed.invalid) {
    const offendingPath = localRead.parsed.invalid ? localConfigPath : globalConfigPath;
    const details = localRead.parsed.invalid ? localRead.parsed.errors : globalRead.parsed.errors;
    return {
      resolution: baseResolution(),
      providerConfig: null,
      error: {
        code: 'CONFIG_INVALID_PROVIDER_REGISTRY',
        message: `invalid provider registry in ${offendingPath}`,
        details,
      },
    };
  }

  if (input.mock) {
    return {
      resolution: baseResolution({
        selected_config_source: 'default',
        provider: 'mock',
        provider_label: 'Mock',
      }),
      providerConfig: null,
    };
  }

  // Resolve the active provider id: CLI flag > merged defaults.flash.provider.
  const providerId = cli.provider?.trim() || merged.flash.provider.value;
  const providerSource: FieldSource = cli.provider?.trim()
    ? 'cli'
    : merged.flash.provider.origin === 'none'
      ? 'none'
      : merged.flash.provider.origin;

  const modelId = cli.model?.trim() || merged.flash.model.value;
  const modelSource: FieldSource = cli.model?.trim()
    ? 'cli'
    : merged.flash.model.origin === 'none'
      ? 'none'
      : merged.flash.model.origin;

  // Numeric tuning: CLI flag > merged defaults.flash.* .
  const pickNumber = (cliVal: number | undefined, field: MergedRegistry['flash']['timeout_ms']): { value?: number; source: FieldSource } => {
    if (cliVal !== undefined && !Number.isNaN(cliVal)) return { value: cliVal, source: 'cli' };
    if (field.value !== undefined) return { value: field.value, source: field.origin === 'none' ? 'none' : field.origin };
    return { source: 'none' };
  };
  const timeout = pickNumber(cli.timeoutMs, merged.flash.timeout_ms);
  const maxTokens = pickNumber(cli.maxTokens, merged.flash.max_tokens);
  const temperature = pickNumber(cli.temperature, merged.flash.temperature);

  const partialSourceMap = (extra: Partial<ConfigSourceMap> = {}): ConfigSourceMap => ({
    provider: providerSource,
    model: modelSource,
    baseUrl: 'none',
    timeout: timeout.source,
    maxTokens: maxTokens.source,
    temperature: temperature.source,
    apiKey: 'none',
    ...extra,
  });

  if (!providerId) {
    return {
      resolution: baseResolution({ source_map: partialSourceMap() }),
      providerConfig: null,
      error: {
        code: 'FLASH_PROVIDER_NOT_CONFIGURED',
        message: 'no flash provider configured',
        details: [],
      },
    };
  }

  const selectedProvider = merged.providers.get(providerId);
  if (!selectedProvider) {
    return {
      resolution: baseResolution({ provider: providerId, model: modelId ?? null, source_map: partialSourceMap() }),
      providerConfig: null,
      error: {
        code: 'CONFIG_PROVIDER_NOT_FOUND',
        message: `flash provider "${providerId}" is not defined in the provider registry`,
        details: [`available providers: ${[...merged.providers.keys()].join(', ') || '(none)'}`],
      },
    };
  }

  const entry: ProviderEntry = selectedProvider.entry;
  const baseUrlSource: FieldSource = selectedProvider.origin;
  const providerLabel = entry.label ?? null;
  const providerType = entry.type ?? null;

  if (!modelId) {
    return {
      resolution: baseResolution({
        provider: providerId,
        provider_label: providerLabel,
        provider_type: providerType,
        baseUrl_host: safeHost(entry.base_url),
        api_key_env: entry.api_key_env ?? null,
        source_map: partialSourceMap({ baseUrl: baseUrlSource }),
      }),
      providerConfig: null,
      error: {
        code: 'FLASH_MODEL_NOT_CONFIGURED',
        message: `no flash model selected for provider "${providerId}"`,
        details: [],
      },
    };
  }

  const modelEntry = entry.models.find((m) => m.id === modelId);
  if (!modelEntry) {
    return {
      resolution: baseResolution({
        provider: providerId,
        provider_label: providerLabel,
        provider_type: providerType,
        model: modelId,
        baseUrl_host: safeHost(entry.base_url),
        api_key_env: entry.api_key_env ?? null,
        source_map: partialSourceMap({ baseUrl: baseUrlSource }),
      }),
      providerConfig: null,
      error: {
        code: 'CONFIG_MODEL_NOT_FOUND',
        message: `model "${modelId}" is not defined for provider "${providerId}"`,
        details: [`available models: ${entry.models.map((m) => m.id).join(', ') || '(none)'}`],
      },
    };
  }
  const modelLabel = modelEntry.label ?? null;

  const selectedSource = aggregateSelectedSource([providerSource, modelSource, baseUrlSource]);

  // API key resolution for the selected provider.
  const apiKeyEnv = entry.api_key_env ?? null;
  if (!apiKeyEnv) {
    return {
      resolution: baseResolution({
        selected_config_source: selectedSource,
        provider: providerId,
        provider_label: providerLabel,
        provider_type: providerType,
        model: modelId,
        model_label: modelLabel,
        baseUrl_host: safeHost(entry.base_url),
        api_key_env: null,
        timeoutMs: timeout.value ?? null,
        maxTokens: maxTokens.value ?? null,
        temperature: temperature.value ?? null,
        source_map: partialSourceMap({ baseUrl: baseUrlSource }),
      }),
      providerConfig: null,
      error: {
        code: 'PROVIDER_API_KEY_ENV_MISSING',
        message: `flash provider "${providerId}" has no api_key_env; set api_key_env in config.yaml`,
        details: [`provider: ${providerId}`],
      },
    };
  }

  const apiKeyLookup = readEnvValue(apiKeyEnv, dotEnv, env);
  const apiKeySource: FieldSource = apiKeyLookup ? apiKeyLookup.source : 'none';
  const apiKeySourceString = apiKeyLookup
    ? `${apiKeyLookup.source === 'env' ? 'global-env' : 'process-env'}:${apiKeyEnv}`
    : null;

  const resolution: ConfigResolution = baseResolution({
    selected_config_source: selectedSource,
    provider: providerId,
    provider_label: providerLabel,
    provider_type: providerType,
    model: modelId,
    model_label: modelLabel,
    baseUrl_host: safeHost(entry.base_url),
    api_key_env: apiKeyEnv,
    api_key_source: apiKeySourceString,
    timeoutMs: timeout.value ?? null,
    maxTokens: maxTokens.value ?? null,
    temperature: temperature.value ?? null,
    has_api_key: Boolean(apiKeyLookup),
    source_map: partialSourceMap({ baseUrl: baseUrlSource, apiKey: apiKeySource }),
  });

  if (!apiKeyLookup) {
    return {
      resolution,
      providerConfig: null,
      error: {
        code: 'FLASH_PROVIDER_AUTH_MISSING',
        message: `flash provider "${providerId}" has no API key; set ${apiKeyEnv} in the AppData .env file`,
        details: [`provider: ${providerId}`, `api_key_env: ${apiKeyEnv}`],
      },
    };
  }

  const providerConfig: ProviderConfig = {
    provider: providerId,
    apiKey: apiKeyLookup.value as string,
    apiKeyEnv,
    baseUrl: entry.base_url,
    model: modelId,
    live: input.live ?? false,
  };
  if (providerLabel) providerConfig.providerLabel = providerLabel;
  if (modelLabel) providerConfig.modelLabel = modelLabel;
  if (timeout.value !== undefined) providerConfig.timeoutMs = timeout.value;
  if (maxTokens.value !== undefined) providerConfig.maxTokens = maxTokens.value;
  if (temperature.value !== undefined) providerConfig.temperature = temperature.value;

  return { resolution, providerConfig };
}

function sanitizeYamlForCopy(rawYaml: string): string {
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawYaml);
  } catch {
    return rawYaml;
  }
  if (!parsed || typeof parsed !== 'object') {
    return rawYaml;
  }
  const strip = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const record = obj as Record<string, unknown>;
      if (isSecretKey(key)) {
        delete record[key];
        continue;
      }
      if (record[key] && typeof record[key] === 'object') strip(record[key]);
    }
  };
  strip(parsed);
  return YAML.stringify(parsed);
}

const MINIMAL_LOCAL_CONFIG = [
  '# VibecodeLight local workspace config (.vibecode/config.yaml)',
  '#',
  '# Local workspace config takes priority over the global config at',
  '# %LOCALAPPDATA%/vibecodelight/config.yaml. Secrets (API keys) live ONLY in',
  '# %LOCALAPPDATA%/vibecodelight/.env, referenced here by api_key_env NAME only.',
  '#',
  '# Add providers and select an active flash provider/model, e.g.:',
  '#   providers:',
  '#     lmstudio:',
  '#       type: openai-compatible',
  '#       label: LM Studio',
  '#       base_url: http://127.0.0.1:1234/v1',
  '#       api_key_env: LMSTUDIO_API_KEY',
  '#       models:',
  '#         - id: qwen3.5-9b',
  '#           label: Qwen3.5 9B Local',
  '#           role: flash',
  '#       # LM Studio model id must match /v1/models; edit qwen3.5-9b if needed.',
  '#     openrouter:',
  '#       type: openai-compatible',
  '#       base_url: https://openrouter.ai/api/v1',
  '#       api_key_env: OPENROUTER_API_KEY',
  '#       models:',
  '#         - id: deepseek/deepseek-chat',
  '#           role: flash',
  '#   defaults:',
  '#     flash:',
  '#       provider: lmstudio',
  '#       model: qwen3.5-9b',
  'version: 1',
  'providers: {}',
  'defaults:',
  '  flash: {}',
  '',
].join('\n');

export interface EnsureLocalConfigResult {
  localConfigPath: string;
  globalConfigPath: string;
  globalConfigExists: boolean;
  created: boolean;
  alreadyExisted: boolean;
  createdFromGlobal: boolean;
  source: 'existing' | 'global-snapshot' | 'defaults';
}

/**
 * Ensure a per-repository local workspace config exists. When missing, create it
 * as a sanitized snapshot of the global config (if present), otherwise write a
 * minimal local config with safe defaults. Never overwrites an existing local
 * config (that requires explicit sync).
 */
export function ensureLocalConfig(opts: {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
  localConfigPath?: string;
}): EnsureLocalConfigResult {
  const env = opts.env ?? process.env;
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(env).config;
  const localConfigPath = opts.localConfigPath ?? getLocalConfigPath(opts.repoRoot);
  const globalConfigExists = fs.existsSync(globalConfigPath);

  if (fs.existsSync(localConfigPath)) {
    return {
      localConfigPath,
      globalConfigPath,
      globalConfigExists,
      created: false,
      alreadyExisted: true,
      createdFromGlobal: false,
      source: 'existing',
    };
  }

  fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });

  if (globalConfigExists) {
    const snapshot = sanitizeYamlForCopy(fs.readFileSync(globalConfigPath, 'utf8'));
    fs.writeFileSync(localConfigPath, snapshot, 'utf8');
    return {
      localConfigPath,
      globalConfigPath,
      globalConfigExists,
      created: true,
      alreadyExisted: false,
      createdFromGlobal: true,
      source: 'global-snapshot',
    };
  }

  fs.writeFileSync(localConfigPath, MINIMAL_LOCAL_CONFIG, 'utf8');
  return {
    localConfigPath,
    globalConfigPath,
    globalConfigExists,
    created: true,
    alreadyExisted: false,
    createdFromGlobal: false,
    source: 'defaults',
  };
}

export interface SyncConfigResult {
  ok: boolean;
  direction: 'from-global' | 'to-global';
  sourcePath: string;
  destinationPath: string;
  error?: { code: string; message: string; details: string[] };
}

/**
 * Explicitly sync config from global AppData to local repo.
 * Only global → local direction is supported.
 * Local → global is disabled: local .vibecode/config.yaml is a per-repo override
 * and must never overwrite global config.
 * .env is never copied in either direction.
 */
export function syncConfig(opts: {
  direction: 'from-global' | 'to-global';
  repoRoot: string;
  env?: Record<string, string | undefined>;
  globalConfigPath?: string;
  localConfigPath?: string;
}): SyncConfigResult {
  const env = opts.env ?? process.env;
  const globalConfigPath = opts.globalConfigPath ?? getGlobalConfigPaths(env).config;
  const localConfigPath = opts.localConfigPath ?? getLocalConfigPath(opts.repoRoot);

  if (opts.direction === 'to-global') {
    return {
      ok: false,
      direction: 'to-global',
      sourcePath: localConfigPath,
      destinationPath: globalConfigPath,
      error: {
        code: 'CONFIG_SYNC_TO_GLOBAL_DISABLED',
        message: 'Local-to-global config sync is disabled. Use global-to-local sync only.',
        details: [],
      },
    };
  }

  if (!fs.existsSync(globalConfigPath)) {
    return {
      ok: false,
      direction: 'from-global',
      sourcePath: globalConfigPath,
      destinationPath: localConfigPath,
      error: {
        code: 'GLOBAL_CONFIG_NOT_FOUND',
        message: `global config not found at ${globalConfigPath}`,
        details: [],
      },
    };
  }
  fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
  fs.writeFileSync(localConfigPath, sanitizeYamlForCopy(fs.readFileSync(globalConfigPath, 'utf8')), 'utf8');
  return { ok: true, direction: 'from-global', sourcePath: globalConfigPath, destinationPath: localConfigPath };
}

/** Write the safe config resolution artifact for a run. */
export function writeConfigResolution(runDir: string, resolution: ConfigResolution): string {
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = path.join(runDir, 'config_resolution.json');
  fs.writeFileSync(filePath, `${JSON.stringify(resolution, null, 2)}\n`, 'utf8');
  return filePath;
}
