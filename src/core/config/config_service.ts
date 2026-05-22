import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import type { ProviderConfig } from '../../adapters/llm/provider_config.js';
import { loadEnvFile } from './env_file.js';
import { getGlobalConfigPaths, getLocalConfigPath } from './user_profile.js';

export type FieldSource = 'cli' | 'local' | 'env' | 'global' | 'process-env' | 'default' | 'none';
export type SelectedConfigSource = 'local' | 'global' | 'env' | 'cli' | 'default' | 'mixed';

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
  provider: string | null;
  model: string | null;
  /** Host only — never a full URL that could contain credentials. */
  baseUrl_host: string | null;
  timeoutMs: number | null;
  maxTokens: number | null;
  temperature: number | null;
  /** Whether an API key was found — the value is never recorded. */
  has_api_key: boolean;
  source_map: ConfigSourceMap;
  warnings: string[];
}

export interface CliConfigFlags {
  provider?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  apiKey?: string;
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
    code: 'FLASH_PROVIDER_NOT_CONFIGURED' | 'FLASH_PROVIDER_AUTH_MISSING';
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

interface NonSecretYaml {
  provider?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

interface YamlReadResult {
  config: NonSecretYaml;
  secretKeysFound: string[];
}

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes('api_key') ||
    k.includes('apikey') ||
    k.includes('secret') ||
    k.includes('token') ||
    k.includes('password')
  );
}

function safeHost(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    const stripped = baseUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    return stripped || null;
  }
}

function readYamlConfig(filePath: string): YamlReadResult {
  if (!fs.existsSync(filePath)) {
    return { config: {}, secretKeysFound: [] };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { config: {}, secretKeysFound: [] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { config: {}, secretKeysFound: [] };
  }

  const secretKeysFound: string[] = [];
  const collectSecrets = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSecretKey(key)) secretKeysFound.push(key);
      if (value && typeof value === 'object') collectSecrets(value);
    }
  };
  collectSecrets(parsed);

  const root = parsed as Record<string, unknown>;
  const models = (root.models && typeof root.models === 'object' ? root.models : {}) as Record<string, unknown>;

  const str = (v: unknown): string | undefined => {
    if (typeof v === 'string') {
      const t = v.trim();
      return t.length > 0 ? t : undefined;
    }
    return undefined;
  };
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
    return undefined;
  };

  const config: NonSecretYaml = {
    provider: str(models.flash_provider),
    model: str(models.flash_model),
    baseUrl: str(models.flash_base_url),
    timeoutMs: num(models.flash_timeout_ms),
    maxTokens: num(models.flash_max_tokens),
    temperature: num(models.flash_temperature),
  };

  return { config, secretKeysFound };
}

interface StringLayer {
  source: FieldSource;
  value?: string;
}

function pickString(layers: StringLayer[]): { value?: string; source: FieldSource } {
  for (const layer of layers) {
    const v = layer.value?.trim();
    if (v) return { value: v, source: layer.source };
  }
  return { source: 'none' };
}

interface NumberLayer {
  source: FieldSource;
  raw: unknown;
}

function pickNumber(layers: NumberLayer[], kind: 'int' | 'float'): { value?: number; source: FieldSource } {
  for (const layer of layers) {
    const raw = layer.raw;
    if (raw === undefined || raw === null || raw === '') continue;
    const n = typeof raw === 'number' ? raw : kind === 'int' ? parseInt(String(raw), 10) : parseFloat(String(raw));
    if (!Number.isNaN(n)) return { value: n, source: layer.source };
  }
  return { source: 'none' };
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
 * Resolve flash provider configuration from CLI flags, local workspace config,
 * AppData .env, and AppData global config — in that priority order for non-secret
 * settings. API keys resolve from CLI flags, AppData .env, then process env.
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

  const globalConfigExists = fs.existsSync(globalConfigPath);
  const globalEnvExists = fs.existsSync(globalEnvPath);
  const localConfigExists = fs.existsSync(localConfigPath);

  const warnings: string[] = [];

  const globalYaml = readYamlConfig(globalConfigPath);
  const localYaml = readYamlConfig(localConfigPath);
  const dotEnv = loadEnvFile(globalEnvPath);

  for (const key of globalYaml.secretKeysFound) {
    warnings.push(`ignored secret key "${key}" in global config ${globalConfigPath}; secrets must live in the AppData .env file`);
  }
  for (const key of localYaml.secretKeysFound) {
    warnings.push(`ignored secret key "${key}" in local config ${localConfigPath}; secrets must live in the AppData .env file`);
  }

  // Non-secret field resolution: cli > local > AppData .env > global.
  const provider = pickString([
    { source: 'cli', value: cli.provider },
    { source: 'local', value: localYaml.config.provider },
    { source: 'env', value: dotEnv.VIBECODE_FLASH_PROVIDER ?? dotEnv.VIBECODE_PROVIDER },
    { source: 'global', value: globalYaml.config.provider },
  ]);
  const model = pickString([
    { source: 'cli', value: cli.model },
    { source: 'local', value: localYaml.config.model },
    { source: 'env', value: dotEnv.VIBECODE_FLASH_MODEL ?? dotEnv.VIBECODE_MODEL },
    { source: 'global', value: globalYaml.config.model },
  ]);
  const baseUrl = pickString([
    { source: 'cli', value: cli.baseUrl },
    { source: 'local', value: localYaml.config.baseUrl },
    { source: 'env', value: dotEnv.VIBECODE_FLASH_BASE_URL ?? dotEnv.VIBECODE_BASE_URL },
    { source: 'global', value: globalYaml.config.baseUrl },
  ]);
  const timeout = pickNumber(
    [
      { source: 'cli', raw: cli.timeoutMs },
      { source: 'local', raw: localYaml.config.timeoutMs },
      { source: 'env', raw: dotEnv.VIBECODE_FLASH_TIMEOUT_MS },
      { source: 'global', raw: globalYaml.config.timeoutMs },
    ],
    'int',
  );
  const maxTokens = pickNumber(
    [
      { source: 'cli', raw: cli.maxTokens },
      { source: 'local', raw: localYaml.config.maxTokens },
      { source: 'env', raw: dotEnv.VIBECODE_FLASH_MAX_TOKENS },
      { source: 'global', raw: globalYaml.config.maxTokens },
    ],
    'int',
  );
  const temperature = pickNumber(
    [
      { source: 'cli', raw: cli.temperature },
      { source: 'local', raw: localYaml.config.temperature },
      { source: 'env', raw: dotEnv.VIBECODE_FLASH_TEMPERATURE },
      { source: 'global', raw: globalYaml.config.temperature },
    ],
    'float',
  );

  // Secret resolution: cli > AppData .env > process env.
  const apiKey = pickString([
    { source: 'cli', value: cli.apiKey },
    { source: 'env', value: dotEnv.VIBECODE_FLASH_API_KEY ?? dotEnv.VIBECODE_API_KEY },
    { source: 'process-env', value: env.VIBECODE_FLASH_API_KEY ?? env.VIBECODE_API_KEY },
  ]);

  const usedSources = new Set<FieldSource>();
  for (const f of [provider.source, model.source, baseUrl.source]) {
    if (f !== 'none' && f !== 'default') usedSources.add(f);
  }
  let selected: SelectedConfigSource;
  if (input.mock) {
    selected = 'default';
  } else if (usedSources.size === 0) {
    selected = 'default';
  } else if (usedSources.size === 1) {
    selected = [...usedSources][0] as SelectedConfigSource;
  } else {
    selected = 'mixed';
  }

  const resolution: ConfigResolution = {
    global_config_path: globalConfigPath,
    global_env_path: globalEnvPath,
    local_config_path: localConfigPath,
    global_config_exists: globalConfigExists,
    global_env_exists: globalEnvExists,
    local_config_exists: localConfigExists,
    local_config_created_from_global: input.localCreatedFromGlobal ?? false,
    selected_config_source: selected,
    provider: input.mock ? 'mock' : provider.value ?? null,
    model: input.mock ? null : model.value ?? null,
    baseUrl_host: input.mock ? null : safeHost(baseUrl.value),
    timeoutMs: input.mock ? null : timeout.value ?? null,
    maxTokens: input.mock ? null : maxTokens.value ?? null,
    temperature: input.mock ? null : temperature.value ?? null,
    has_api_key: input.mock ? false : Boolean(apiKey.value),
    source_map: {
      provider: input.mock ? 'default' : provider.source,
      model: input.mock ? 'default' : model.source,
      baseUrl: input.mock ? 'default' : baseUrl.source,
      timeout: input.mock ? 'default' : timeout.source,
      maxTokens: input.mock ? 'default' : maxTokens.source,
      temperature: input.mock ? 'default' : temperature.source,
      apiKey: input.mock ? 'none' : apiKey.source,
    },
    warnings,
  };

  if (input.mock) {
    return { resolution, providerConfig: null };
  }

  if (!provider.value || provider.value === 'mock') {
    return {
      resolution,
      providerConfig: null,
      error: {
        code: 'FLASH_PROVIDER_NOT_CONFIGURED',
        message: 'no flash provider configured',
        details: [],
      },
    };
  }

  if (!baseUrl.value) {
    return {
      resolution,
      providerConfig: null,
      error: {
        code: 'FLASH_PROVIDER_NOT_CONFIGURED',
        message: `flash provider "${provider.value}" is missing a base URL`,
        details: [`provider: ${provider.value}`],
      },
    };
  }

  if (!apiKey.value) {
    return {
      resolution,
      providerConfig: null,
      error: {
        code: 'FLASH_PROVIDER_AUTH_MISSING',
        message: `flash provider "${provider.value}" has no API key; set one in the AppData .env file`,
        details: [`provider: ${provider.value}`],
      },
    };
  }

  const providerConfig: ProviderConfig = {
    provider: provider.value,
    apiKey: apiKey.value,
    baseUrl: baseUrl.value,
    live: input.live ?? false,
  };
  if (model.value) providerConfig.model = model.value;
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
  '# %LOCALAPPDATA%/vibecodelight/config.yaml. Secrets (API keys) must live in',
  '# %LOCALAPPDATA%/vibecodelight/.env and never in this file.',
  'models:',
  '  flash_provider: ""',
  '  flash_model: ""',
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
 * Explicitly sync config between global and local. Only ever runs in the
 * direction requested; both directions report the source and destination paths.
 * Secrets are stripped from the copied YAML defensively.
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

  if (opts.direction === 'from-global') {
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

  if (!fs.existsSync(localConfigPath)) {
    return {
      ok: false,
      direction: 'to-global',
      sourcePath: localConfigPath,
      destinationPath: globalConfigPath,
      error: {
        code: 'LOCAL_CONFIG_NOT_FOUND',
        message: `local config not found at ${localConfigPath}`,
        details: [],
      },
    };
  }
  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, sanitizeYamlForCopy(fs.readFileSync(localConfigPath, 'utf8')), 'utf8');
  return { ok: true, direction: 'to-global', sourcePath: localConfigPath, destinationPath: globalConfigPath };
}

/** Write the safe config resolution artifact for a run. */
export function writeConfigResolution(runDir: string, resolution: ConfigResolution): string {
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = path.join(runDir, 'config_resolution.json');
  fs.writeFileSync(filePath, `${JSON.stringify(resolution, null, 2)}\n`, 'utf8');
  return filePath;
}
