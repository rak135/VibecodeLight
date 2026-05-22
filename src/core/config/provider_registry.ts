/**
 * Provider registry config shape and parsing.
 *
 * The human-maintained config.yaml (global AppData and per-repo .vibecode) owns a
 * registry of providers and their available models plus the active flash
 * defaults. This module parses, validates, and merges that registry. It never
 * reads, stores, or returns API key values — only the env-variable NAME that
 * holds each provider's key (`api_key_env`).
 */

export interface ModelEntry {
  id: string;
  label?: string;
  role?: string;
}

export interface ProviderEntry {
  type: string;
  label?: string;
  base_url: string;
  /** The NAME of the .env variable that holds this provider's API key. Never the value. */
  api_key_env?: string;
  models: ModelEntry[];
}

export interface FlashDefaults {
  provider?: string;
  model?: string;
  timeout_ms?: number;
  max_tokens?: number;
  temperature?: number;
}

export interface ProviderRegistry {
  version?: number;
  providers: Record<string, ProviderEntry>;
  defaults: { flash: FlashDefaults };
}

export interface ParsedRegistry {
  /** Always present; providers/defaults may be empty. */
  registry: ProviderRegistry;
  /** True when a providers section is present but malformed. */
  invalid: boolean;
  /** Human-readable validation errors (when invalid). */
  errors: string[];
  /** True when the registry was synthesized from a legacy models.flash_* block. */
  legacy: boolean;
  /** Secret-looking keys discovered anywhere in the document (key names only). */
  secretKeysFound: string[];
  /** True when no providers and no usable defaults were found. */
  empty: boolean;
}

export type ConfigOrigin = 'local' | 'global';

export interface MergedProvider {
  id: string;
  entry: ProviderEntry;
  origin: ConfigOrigin;
}

export interface MergedField<T> {
  value: T | undefined;
  origin: ConfigOrigin | 'none';
}

export interface MergedFlashDefaults {
  provider: MergedField<string>;
  model: MergedField<string>;
  timeout_ms: MergedField<number>;
  max_tokens: MergedField<number>;
  temperature: MergedField<number>;
}

export interface MergedRegistry {
  providers: Map<string, MergedProvider>;
  flash: MergedFlashDefaults;
}

/**
 * Detect secret-looking config keys. `api_key_env` is intentionally NOT a secret:
 * it holds the NAME of an env variable, not a key value.
 */
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, '');
  // api_key_env is a NON-secret reference to an env var name, not a key value.
  if (k === 'apikeyenv') return false;
  if (k.includes('apikey') || k.includes('secret') || k.includes('password')) return true;
  // "token" indicates a credential, but a plural "*tokens" is a count field
  // (e.g. max_tokens) and must not be treated as a secret.
  if (k.includes('token') && !k.includes('tokens')) return true;
  return false;
}

/** Host only — never a full URL that could carry embedded credentials. */
export function safeHost(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    const stripped = url.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    return stripped || null;
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function collectSecretKeys(obj: unknown, out: string[]): void {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSecretKey(key)) out.push(key);
    if (value && typeof value === 'object') collectSecretKeys(value, out);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function emptyRegistry(): ProviderRegistry {
  return { providers: {}, defaults: { flash: {} } };
}

/**
 * Parse an already-YAML-decoded object into a provider registry. Pure and
 * side-effect-free so it is trivially testable. Reading files and merging
 * global/local lives in the config service.
 */
export function parseRegistryObject(parsed: unknown): ParsedRegistry {
  const secretKeysFound: string[] = [];
  if (!isPlainObject(parsed)) {
    return { registry: emptyRegistry(), invalid: false, errors: [], legacy: false, secretKeysFound, empty: true };
  }
  collectSecretKeys(parsed, secretKeysFound);

  const root = parsed;
  const errors: string[] = [];
  const providers: Record<string, ProviderEntry> = {};
  let invalid = false;

  const rawProviders = root.providers;
  if (rawProviders !== undefined && rawProviders !== null) {
    if (!isPlainObject(rawProviders)) {
      invalid = true;
      errors.push('providers must be a mapping of provider id to provider config');
    } else {
      for (const [id, rawEntry] of Object.entries(rawProviders)) {
        if (!isPlainObject(rawEntry)) {
          invalid = true;
          errors.push(`provider "${id}" must be a mapping`);
          continue;
        }
        const type = str(rawEntry.type);
        const baseUrl = str(rawEntry.base_url);
        if (!type) {
          invalid = true;
          errors.push(`provider "${id}" is missing "type"`);
        }
        if (!baseUrl) {
          invalid = true;
          errors.push(`provider "${id}" is missing "base_url"`);
        }

        const models: ModelEntry[] = [];
        if (rawEntry.models !== undefined && rawEntry.models !== null) {
          if (!Array.isArray(rawEntry.models)) {
            invalid = true;
            errors.push(`provider "${id}" models must be a list`);
          } else {
            for (const rawModel of rawEntry.models) {
              if (!isPlainObject(rawModel)) {
                invalid = true;
                errors.push(`provider "${id}" has an invalid model entry`);
                continue;
              }
              const mid = str(rawModel.id);
              if (!mid) {
                invalid = true;
                errors.push(`provider "${id}" has a model entry missing "id"`);
                continue;
              }
              const model: ModelEntry = { id: mid };
              const mlabel = str(rawModel.label);
              if (mlabel) model.label = mlabel;
              const mrole = str(rawModel.role);
              if (mrole) model.role = mrole;
              models.push(model);
            }
          }
        }

        if (type && baseUrl) {
          const entry: ProviderEntry = { type, base_url: baseUrl, models };
          const label = str(rawEntry.label);
          if (label) entry.label = label;
          const apiKeyEnv = str(rawEntry.api_key_env);
          if (apiKeyEnv) entry.api_key_env = apiKeyEnv;
          providers[id] = entry;
        }
      }
    }
  }

  const flash: FlashDefaults = {};
  if (isPlainObject(root.defaults)) {
    const rawFlash = root.defaults.flash;
    if (isPlainObject(rawFlash)) {
      const p = str(rawFlash.provider);
      if (p) flash.provider = p;
      const m = str(rawFlash.model);
      if (m) flash.model = m;
      const t = num(rawFlash.timeout_ms);
      if (t !== undefined) flash.timeout_ms = t;
      const mx = num(rawFlash.max_tokens);
      if (mx !== undefined) flash.max_tokens = mx;
      const tp = num(rawFlash.temperature);
      if (tp !== undefined) flash.temperature = tp;
    }
  }

  // Legacy bridge: an old single-provider `models.flash_*` block, only when the
  // new registry produced no providers and the document is otherwise valid.
  let legacy = false;
  if (!invalid && Object.keys(providers).length === 0 && isPlainObject(root.models)) {
    const legacyModels = root.models;
    const legacyProvider = str(legacyModels.flash_provider);
    if (legacyProvider) {
      legacy = true;
      const entry: ProviderEntry = {
        type: 'openai-compatible',
        base_url: str(legacyModels.flash_base_url) ?? '',
        api_key_env: 'VIBECODE_FLASH_API_KEY',
        models: [],
      };
      const legacyModel = str(legacyModels.flash_model);
      if (legacyModel) entry.models.push({ id: legacyModel, role: 'flash' });
      providers[legacyProvider] = entry;
      if (!flash.provider) flash.provider = legacyProvider;
      if (!flash.model && legacyModel) flash.model = legacyModel;
      const t = num(legacyModels.flash_timeout_ms);
      if (t !== undefined && flash.timeout_ms === undefined) flash.timeout_ms = t;
      const mx = num(legacyModels.flash_max_tokens);
      if (mx !== undefined && flash.max_tokens === undefined) flash.max_tokens = mx;
      const tp = num(legacyModels.flash_temperature);
      if (tp !== undefined && flash.temperature === undefined) flash.temperature = tp;
    }
  }

  const registry: ProviderRegistry = { providers, defaults: { flash } };
  const version = num(root.version);
  if (version !== undefined) registry.version = version;

  const empty = Object.keys(providers).length === 0 && Object.keys(flash).length === 0;
  return { registry, invalid, errors, legacy, secretKeysFound, empty };
}

/**
 * Merge a global and a local registry. Providers merge by id with the local
 * entry fully replacing a global entry of the same id; global-only providers are
 * retained. Flash defaults merge field-by-field with local taking priority. Each
 * result records its origin so callers can report the per-field config source.
 */
export function mergeRegistries(
  globalReg: ProviderRegistry | null,
  localReg: ProviderRegistry | null,
): MergedRegistry {
  const providers = new Map<string, MergedProvider>();
  if (globalReg) {
    for (const [id, entry] of Object.entries(globalReg.providers)) {
      providers.set(id, { id, entry, origin: 'global' });
    }
  }
  if (localReg) {
    for (const [id, entry] of Object.entries(localReg.providers)) {
      providers.set(id, { id, entry, origin: 'local' });
    }
  }

  const field = <T>(localVal: T | undefined, globalVal: T | undefined): MergedField<T> => {
    if (localVal !== undefined) return { value: localVal, origin: 'local' };
    if (globalVal !== undefined) return { value: globalVal, origin: 'global' };
    return { value: undefined, origin: 'none' };
  };

  const gf = globalReg?.defaults.flash ?? {};
  const lf = localReg?.defaults.flash ?? {};

  return {
    providers,
    flash: {
      provider: field(lf.provider, gf.provider),
      model: field(lf.model, gf.model),
      timeout_ms: field(lf.timeout_ms, gf.timeout_ms),
      max_tokens: field(lf.max_tokens, gf.max_tokens),
      temperature: field(lf.temperature, gf.temperature),
    },
  };
}
