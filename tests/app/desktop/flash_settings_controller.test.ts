import FlashSettings from '../../../src/app/desktop/renderer/flash_settings.js';

// The controller is a DOM-free orchestrator: it calls the preload config APIs
// (each backed by the core config service), maps the safe responses through the
// presenter, and pushes view-models into an injected view. It owns no config
// logic and never parses files.

const SECRET = 'sk-controller-secret-should-never-render';

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
        models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
      },
      {
        id: 'openrouter',
        label: 'OpenRouter',
        type: 'openai-compatible',
        baseUrl_host: 'openrouter.ai',
        api_key_env: 'OPENROUTER_API_KEY',
        has_api_key: true,
        origin: 'local',
        models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat via OpenRouter', role: 'flash' }],
      },
    ],
    warnings: [],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- permissive test fixture
function makeApi(overrides: Record<string, unknown> = {}): any {
  const r = resolution();
  return {
    show: vi.fn().mockResolvedValue({ ok: true, resolution: r }),
    providers: vi.fn().mockResolvedValue({
      ok: true,
      providers: r.providers,
      active_provider: 'openrouter',
      active_model: 'deepseek/deepseek-chat',
      config_source: 'local',
      local_config_path: r.local_config_path,
      global_config_path: r.global_config_path,
      global_env_path: r.global_env_path,
    }),
    syncFromGlobal: vi.fn().mockResolvedValue({ ok: true, direction: 'from-global', sourcePath: 'g', destinationPath: 'l' }),
    openDir: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeView() {
  return {
    pill: null as unknown,
    settings: null as unknown,
    providers: null as unknown,
    composer: null as unknown,
    statuses: [] as Array<{ text: string; kind?: string }>,
    setPill(p: unknown) { this.pill = p; },
    setSettings(rows: unknown) { this.settings = rows; },
    setProviders(list: unknown) { this.providers = list; },
    setComposer(model: unknown) { this.composer = model; },
    setStatus(text: string, kind?: string) { this.statuses.push({ text, kind }); },
  };
}

describe('flash settings controller', () => {
  test('refresh loads config from preload config.show and config.providers', async () => {
    const api = makeApi();
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    await controller.refresh();

    expect(api.show).toHaveBeenCalledTimes(1);
    expect(api.providers).toHaveBeenCalledTimes(1);
    expect((view.pill as { text: string; mode: string }).text).toBe('Flash: Mock');
    expect((view.pill as { mode: string }).mode).toBe('mock');
    expect(Array.isArray(view.settings)).toBe(true);
    expect((view.providers as unknown[]).length).toBe(2);
    expect((view.composer as { defaultProvider: string }).defaultProvider).toBe('openrouter');
  });

  test('setMode("live") re-renders the header pill with provider/model without refetching config', async () => {
    const api = makeApi();
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    await controller.refresh();
    expect((view.pill as { mode: string }).mode).toBe('mock');

    controller.setMode('live');

    expect((view.pill as { text: string; mode: string }).text).toBe(
      'Flash: Live · OpenRouter · deepseek/deepseek-chat',
    );
    expect((view.pill as { mode: string }).mode).toBe('live');
    // No extra config fetch is required to flip the visible mode.
    expect(api.show).toHaveBeenCalledTimes(1);
    expect(api.providers).toHaveBeenCalledTimes(1);

    controller.setMode('mock');
    expect((view.pill as { text: string }).text).toBe('Flash: Mock');
  });

  test('sync global -> local calls preload config.syncFromGlobal then refreshes the panel', async () => {
    const api = makeApi();
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    await controller.refresh();
    expect(api.show).toHaveBeenCalledTimes(1);

    await controller.syncFromGlobal();

    expect(api.syncFromGlobal).toHaveBeenCalledTimes(1);
    // Panel refreshed: show/providers fetched again after the sync.
    expect(api.show).toHaveBeenCalledTimes(2);
    expect(api.providers).toHaveBeenCalledTimes(2);
    expect(view.statuses.some((s) => s.kind === 'ok')).toBe(true);
  });

  test('controller does not expose syncToGlobal (local-to-global sync is disabled)', () => {
    const api = makeApi();
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    expect(typeof (controller as unknown as Record<string, unknown>)['syncToGlobal']).toBe('undefined');
  });

  test('open config folder delegates to preload config.openDir', async () => {
    const api = makeApi();
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    await controller.openConfigFolder();

    expect(api.openDir).toHaveBeenCalledTimes(1);
  });

  test('a failed sync surfaces a safe diagnostic and does not refresh', async () => {
    const api = makeApi({
      syncFromGlobal: vi.fn().mockResolvedValue({
        ok: false,
        direction: 'from-global',
        sourcePath: 'g',
        destinationPath: 'l',
        error: { code: 'GLOBAL_CONFIG_NOT_FOUND', message: 'global config not found', details: [] },
      }),
    });
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    await controller.refresh();
    await controller.syncFromGlobal();

    const errorStatus = view.statuses.find((s) => s.kind === 'error');
    expect(errorStatus).toBeTruthy();
    expect(errorStatus?.text).toContain('GLOBAL_CONFIG_NOT_FOUND');
    // No second refresh on failure.
    expect(api.show).toHaveBeenCalledTimes(1);
  });

  test('an exception while loading config is shown as a safe diagnostic', async () => {
    const api = makeApi({ show: vi.fn().mockRejectedValue(new Error('ipc exploded')) });
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    await controller.refresh();

    expect(view.statuses.some((s) => s.kind === 'error')).toBe(true);
  });

  test('rendered view-models never contain an API key value', async () => {
    const r = resolution({ apiKey: SECRET, api_key: SECRET });
    const api = makeApi({ show: vi.fn().mockResolvedValue({ ok: true, resolution: r }) });
    const view = makeView();
    const controller = FlashSettings.createController({ api, view });

    await controller.refresh();

    const snapshot = JSON.stringify({
      pill: view.pill,
      settings: view.settings,
      providers: view.providers,
      composer: view.composer,
      statuses: view.statuses,
    });
    expect(snapshot).not.toContain(SECRET);
  });
});
