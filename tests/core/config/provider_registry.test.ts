import {
  parseRegistryObject,
  mergeRegistries,
  isSecretKey,
  safeHost,
} from '../../../src/core/config/provider_registry.js';

const EXAMPLE = {
  version: 1,
  providers: {
    openrouter: {
      type: 'openai-compatible',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_env: 'OPENROUTER_API_KEY',
      models: [
        { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat via OpenRouter', role: 'flash' },
        { id: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner via OpenRouter', role: 'flash' },
      ],
    },
    deepseek: {
      type: 'openai-compatible',
      label: 'DeepSeek',
      base_url: 'https://api.deepseek.com',
      api_key_env: 'DEEPSEEK_API_KEY',
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat', role: 'flash' },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', role: 'flash' },
      ],
    },
  },
  defaults: {
    flash: {
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      timeout_ms: 30000,
      max_tokens: 4096,
      temperature: 0.1,
    },
  },
};

describe('parseRegistryObject', () => {
  test('parses the new provider registry config', () => {
    const parsed = parseRegistryObject(EXAMPLE);
    expect(parsed.invalid).toBe(false);
    expect(parsed.legacy).toBe(false);
    expect(parsed.empty).toBe(false);
    expect(Object.keys(parsed.registry.providers).sort()).toEqual(['deepseek', 'openrouter']);
    expect(parsed.registry.defaults.flash.provider).toBe('openrouter');
    expect(parsed.registry.defaults.flash.model).toBe('deepseek/deepseek-chat');
    expect(parsed.registry.defaults.flash.timeout_ms).toBe(30000);
    expect(parsed.registry.defaults.flash.max_tokens).toBe(4096);
    expect(parsed.registry.defaults.flash.temperature).toBe(0.1);
  });

  test('supports the OpenRouter provider config', () => {
    const parsed = parseRegistryObject(EXAMPLE);
    const openrouter = parsed.registry.providers.openrouter;
    expect(openrouter.type).toBe('openai-compatible');
    expect(openrouter.label).toBe('OpenRouter');
    expect(openrouter.base_url).toBe('https://openrouter.ai/api/v1');
    expect(openrouter.api_key_env).toBe('OPENROUTER_API_KEY');
    expect(openrouter.models.map((m) => m.id)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner']);
    expect(openrouter.models[0].role).toBe('flash');
  });

  test('supports the DeepSeek provider config', () => {
    const parsed = parseRegistryObject(EXAMPLE);
    const deepseek = parsed.registry.providers.deepseek;
    expect(deepseek.base_url).toBe('https://api.deepseek.com');
    expect(deepseek.api_key_env).toBe('DEEPSEEK_API_KEY');
    expect(deepseek.models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  test('supports arbitrary provider and model ids (no hardcoded truth)', () => {
    const parsed = parseRegistryObject({
      providers: {
        'my-custom-host': {
          type: 'openai-compatible',
          base_url: 'https://example.invalid/v1',
          api_key_env: 'MY_CUSTOM_KEY',
          models: [{ id: 'org/some-arbitrary-model', role: 'flash' }],
        },
      },
      defaults: { flash: { provider: 'my-custom-host', model: 'org/some-arbitrary-model' } },
    });
    expect(parsed.invalid).toBe(false);
    expect(parsed.registry.providers['my-custom-host'].models[0].id).toBe('org/some-arbitrary-model');
  });

  test('rejects an invalid provider registry (providers not an object)', () => {
    const parsed = parseRegistryObject({ providers: ['not', 'an', 'object'] });
    expect(parsed.invalid).toBe(true);
    expect(parsed.errors.join(' ')).toMatch(/providers/i);
  });

  test('rejects a provider entry missing required base_url/type', () => {
    const parsed = parseRegistryObject({ providers: { broken: { label: 'Broken' } } });
    expect(parsed.invalid).toBe(true);
  });

  test('rejects a model entry missing an id', () => {
    const parsed = parseRegistryObject({
      providers: { p: { type: 'openai-compatible', base_url: 'https://x.invalid', models: [{ label: 'no id' }] } },
    });
    expect(parsed.invalid).toBe(true);
  });

  test('rejects defaults.flash.timeout_ms when it is not a positive integer', () => {
    const parsed = parseRegistryObject({
      providers: {
        openrouter: {
          type: 'openai-compatible',
          base_url: 'https://openrouter.ai/api/v1',
          api_key_env: 'OPENROUTER_API_KEY',
          models: [{ id: 'deepseek/deepseek-chat', role: 'flash' }],
        },
      },
      defaults: { flash: { provider: 'openrouter', model: 'deepseek/deepseek-chat', timeout_ms: 0 } },
    });
    expect(parsed.invalid).toBe(true);
    expect(parsed.errors.join(' ')).toMatch(/timeout_ms/i);
    expect(parsed.errors.join(' ')).toMatch(/positive integer/i);
  });

  test('empty object is valid but empty', () => {
    const parsed = parseRegistryObject({});
    expect(parsed.invalid).toBe(false);
    expect(parsed.empty).toBe(true);
    expect(Object.keys(parsed.registry.providers)).toEqual([]);
  });

  test('synthesizes a legacy provider from models.flash_* with a deprecation note', () => {
    const parsed = parseRegistryObject({
      models: {
        flash_provider: 'legacyhost',
        flash_model: 'legacy-model',
        flash_base_url: 'https://legacy.invalid/v1',
      },
    });
    expect(parsed.invalid).toBe(false);
    expect(parsed.legacy).toBe(true);
    expect(parsed.registry.providers.legacyhost.base_url).toBe('https://legacy.invalid/v1');
    expect(parsed.registry.defaults.flash.provider).toBe('legacyhost');
    expect(parsed.registry.defaults.flash.model).toBe('legacy-model');
    expect(parsed.secretKeysFound).toEqual([]);
  });

  test('records secret keys found anywhere in the document', () => {
    const parsed = parseRegistryObject({
      providers: {
        p: { type: 'openai-compatible', base_url: 'https://x.invalid', api_key: 'sk-leak', models: [] },
      },
    });
    expect(parsed.secretKeysFound).toContain('api_key');
  });
});

describe('mergeRegistries', () => {
  test('local provider entry overrides the global provider entry of the same id', () => {
    const globalReg = parseRegistryObject({
      providers: { p: { type: 'openai-compatible', label: 'Global', base_url: 'https://global.invalid', api_key_env: 'G', models: [] } },
      defaults: { flash: { provider: 'p' } },
    }).registry;
    const localReg = parseRegistryObject({
      providers: { p: { type: 'openai-compatible', label: 'Local', base_url: 'https://local.invalid', api_key_env: 'L', models: [] } },
    }).registry;

    const merged = mergeRegistries(globalReg, localReg);
    const p = merged.providers.get('p');
    expect(p?.origin).toBe('local');
    expect(p?.entry.label).toBe('Local');
    expect(p?.entry.base_url).toBe('https://local.invalid');
  });

  test('global-only providers are retained alongside local providers', () => {
    const globalReg = parseRegistryObject({
      providers: { g: { type: 'openai-compatible', base_url: 'https://g.invalid', models: [] } },
    }).registry;
    const localReg = parseRegistryObject({
      providers: { l: { type: 'openai-compatible', base_url: 'https://l.invalid', models: [] } },
    }).registry;

    const merged = mergeRegistries(globalReg, localReg);
    expect([...merged.providers.keys()].sort()).toEqual(['g', 'l']);
    expect(merged.providers.get('g')?.origin).toBe('global');
    expect(merged.providers.get('l')?.origin).toBe('local');
  });

  test('flash defaults merge field-by-field with local taking priority', () => {
    const globalReg = parseRegistryObject({
      defaults: { flash: { provider: 'gp', model: 'gm', timeout_ms: 1000 } },
    }).registry;
    const localReg = parseRegistryObject({
      defaults: { flash: { provider: 'lp' } },
    }).registry;

    const merged = mergeRegistries(globalReg, localReg);
    expect(merged.flash.provider.value).toBe('lp');
    expect(merged.flash.provider.origin).toBe('local');
    expect(merged.flash.model.value).toBe('gm');
    expect(merged.flash.model.origin).toBe('global');
    expect(merged.flash.timeout_ms.value).toBe(1000);
    expect(merged.flash.timeout_ms.origin).toBe('global');
  });

  test('global is used when local is null', () => {
    const globalReg = parseRegistryObject(EXAMPLE).registry;
    const merged = mergeRegistries(globalReg, null);
    expect(merged.flash.provider.value).toBe('openrouter');
    expect(merged.flash.provider.origin).toBe('global');
    expect(merged.providers.get('openrouter')?.origin).toBe('global');
  });
});

describe('helpers', () => {
  test('isSecretKey detects common secret-looking keys', () => {
    expect(isSecretKey('api_key')).toBe(true);
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('OPENROUTER_API_KEY')).toBe(true);
    expect(isSecretKey('secret_token')).toBe(true);
    expect(isSecretKey('access_token')).toBe(true);
    expect(isSecretKey('base_url')).toBe(false);
    expect(isSecretKey('api_key_env')).toBe(false);
    // count fields that merely contain "token" are not secrets
    expect(isSecretKey('max_tokens')).toBe(false);
    expect(isSecretKey('timeout_ms')).toBe(false);
    expect(isSecretKey('temperature')).toBe(false);
  });

  test('safeHost returns host only and never credentials', () => {
    expect(safeHost('https://user:pass@host.example.com/v1')).toBe('host.example.com');
    expect(safeHost('https://openrouter.ai/api/v1')).toBe('openrouter.ai');
    expect(safeHost(undefined)).toBeNull();
  });
});
