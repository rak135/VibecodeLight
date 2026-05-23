import FlashSettings from '../../../src/app/desktop/renderer/flash_settings.js';

// The renderer presenter is a thin, DOM-free mapping layer over the safe
// ConfigResolution / config:providers responses returned by the preload bridge
// (which itself only ever returns secret-free data from the core config
// service). These tests assert the view-model shapes the GUI renders.

const SECRET = 'sk-renderer-secret-should-never-render';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- permissive test fixture
function resolution(overrides: Record<string, unknown> = {}): any {
  return {
    global_config_path: 'C:/AppData/vibecodelight/config.yaml',
    global_env_path: 'C:/AppData/vibecodelight/.env',
    local_config_path: 'C:/repo/.vibecode/config.yaml',
    global_config_exists: true,
    global_env_exists: true,
    local_config_exists: true,
    local_config_created_from_global: false,
    selected_config_source: 'local',
    provider: 'openrouter',
    provider_label: 'OpenRouter',
    provider_type: 'openai-compatible',
    model: 'deepseek/deepseek-chat',
    model_label: 'DeepSeek Chat via OpenRouter',
    baseUrl_host: 'openrouter.ai',
    api_key_env: 'OPENROUTER_API_KEY',
    api_key_source: 'global-env:OPENROUTER_API_KEY',
    has_api_key: true,
    source_map: {},
    providers: [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        type: 'openai-compatible',
        baseUrl_host: 'api.deepseek.com',
        api_key_env: 'DEEPSEEK_API_KEY',
        has_api_key: false,
        origin: 'local',
        models: [
          { id: 'deepseek-chat', label: 'DeepSeek Chat', role: 'flash' },
          { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', role: 'flash' },
        ],
      },
      {
        id: 'openrouter',
        label: 'OpenRouter',
        type: 'openai-compatible',
        baseUrl_host: 'openrouter.ai',
        api_key_env: 'OPENROUTER_API_KEY',
        has_api_key: true,
        origin: 'local',
        models: [
          { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat via OpenRouter', role: 'flash' },
          { id: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner via OpenRouter', role: 'flash' },
        ],
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('flash settings presenter — header pill', () => {
  test('buildPill shows active provider/model and source when configured', () => {
    const pill = FlashSettings.buildPill(resolution());
    expect(pill.available).toBe(true);
    expect(pill.text).toBe('Flash: OpenRouter / deepseek/deepseek-chat');
    expect(pill.sourceText).toBe('Source: local');
  });

  test('buildPill falls back to provider id when label missing', () => {
    const pill = FlashSettings.buildPill(resolution({ provider_label: null }));
    expect(pill.text).toBe('Flash: openrouter / deepseek/deepseek-chat');
  });

  test('buildPill reports not configured when provider is null', () => {
    const pill = FlashSettings.buildPill(resolution({ provider: null, model: null }));
    expect(pill.available).toBe(false);
    expect(pill.text).toBe('Flash: not configured');
  });

  test('buildPill reports not configured for the mock provider', () => {
    const pill = FlashSettings.buildPill(resolution({ provider: 'mock', provider_label: 'Mock', model: null }));
    expect(pill.available).toBe(false);
    expect(pill.text).toBe('Flash: not configured');
  });
});

describe('flash settings presenter — settings rows', () => {
  test('buildSettings exposes active provider/model, source, paths, and api key status', () => {
    const rows = FlashSettings.buildSettings(resolution());
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Provider label']).toBe('OpenRouter');
    expect(byLabel['Provider id']).toBe('openrouter');
    expect(byLabel['Model label']).toBe('DeepSeek Chat via OpenRouter');
    expect(byLabel['Model id']).toBe('deepseek/deepseek-chat');
    expect(byLabel['Config source']).toBe('local');
    expect(byLabel['Local config']).toBe('C:/repo/.vibecode/config.yaml');
    expect(byLabel['Global config']).toBe('C:/AppData/vibecodelight/config.yaml');
    expect(byLabel['Global env']).toBe('C:/AppData/vibecodelight/.env');
    expect(byLabel['API key env']).toBe('OPENROUTER_API_KEY');
    expect(byLabel['API key configured']).toBe('yes');
  });

  test('buildSettings reports API key not configured as no', () => {
    const rows = FlashSettings.buildSettings(resolution({ has_api_key: false }));
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['API key configured']).toBe('no');
  });

  test('buildSettings never renders an API key value even if one leaks into the input', () => {
    // Defensive: the presenter only reads known safe fields, never a key value.
    const rows = FlashSettings.buildSettings(resolution({ apiKey: SECRET, api_key: SECRET }));
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  test('buildSettings shows (none) for absent fields', () => {
    const rows = FlashSettings.buildSettings(
      resolution({ provider: null, provider_label: null, model: null, model_label: null, api_key_env: null }),
    );
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Provider id']).toBe('(none)');
    expect(byLabel['Model id']).toBe('(none)');
    expect(byLabel['API key env']).toBe('(none)');
  });
});

describe('flash settings presenter — provider/model list', () => {
  test('buildProviderList maps providers, models, and per-provider key status', () => {
    const list = FlashSettings.buildProviderList(resolution().providers);
    const openrouter = list.find((p) => p.id === 'openrouter');
    expect(openrouter?.label).toBe('OpenRouter');
    expect(openrouter?.hasApiKey).toBe(true);
    expect(openrouter?.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(openrouter?.models.map((m) => m.id)).toEqual([
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
    ]);
    const deepseek = list.find((p) => p.id === 'deepseek');
    expect(deepseek?.hasApiKey).toBe(false);
    expect(deepseek?.models[0].label).toBe('DeepSeek Chat');
    expect(deepseek?.models[0].role).toBe('flash');
  });

  test('buildProviderList tolerates an empty list', () => {
    expect(FlashSettings.buildProviderList([])).toEqual([]);
  });
});

describe('flash settings presenter — composer selection', () => {
  test('buildComposerSelection defaults to the resolved provider and model', () => {
    const sel = FlashSettings.buildComposerSelection(resolution());
    expect(sel.defaultProvider).toBe('openrouter');
    expect(sel.defaultModel).toBe('deepseek/deepseek-chat');
    expect(sel.providers.map((p) => p.id).sort()).toEqual(['deepseek', 'openrouter']);
  });

  test('buildComposerSelection carries an honest mock-only generation note', () => {
    const sel = FlashSettings.buildComposerSelection(resolution());
    expect(sel.note.toLowerCase()).toContain('mock');
    expect(sel.sourceText).toBe('Source: local');
  });

  test('modelsForProvider filters models to the requested provider', () => {
    const models = FlashSettings.modelsForProvider(resolution().providers, 'deepseek');
    expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(FlashSettings.modelsForProvider(resolution().providers, 'unknown')).toEqual([]);
  });
});

describe('flash settings presenter — safe diagnostics', () => {
  test('safeDiagnostic formats a code and message', () => {
    const text = FlashSettings.safeDiagnostic({ code: 'FLASH_PROVIDER_AUTH_MISSING', message: 'no API key' });
    expect(text).toContain('FLASH_PROVIDER_AUTH_MISSING');
    expect(text).toContain('no API key');
  });

  test('safeDiagnostic never includes a secret-looking value', () => {
    const text = FlashSettings.safeDiagnostic({ code: 'X', message: `boom ${SECRET}` });
    // The diagnostic text intentionally drops anything that is not the code/short message.
    expect(text).not.toContain(SECRET);
  });
});
