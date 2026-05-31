import FlashSettings from '../../../src/app/desktop/renderer/flash_settings.js';

// The composer preview routing is the renderer-side decision that turns the
// visible Mock/Live selector into the correct preload call. It owns no config
// logic: it only routes to composer.generatePreview (mock) or
// composer.generatePreviewLive (live), and uses the safe, secret-free provider
// list (has_api_key boolean + api_key_env NAME) to gate live mode. It must never
// silently fall back from Live to Mock and never echo an API key value.

const SECRET = 'sk-composer-secret-should-never-render';

interface ProviderListItem {
  id: string;
  label: string | null;
  hasApiKey: boolean;
  apiKeyEnv: string | null;
  models: Array<{ id: string; label: string | null; role: string | null }>;
}

function providerList(): ProviderListItem[] {
  return [
    {
      id: 'openrouter',
      label: 'OpenRouter',
      hasApiKey: true,
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: [{ id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat via OpenRouter', role: 'flash' }],
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      hasApiKey: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', role: 'flash' }],
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- permissive test fixture
function makeComposer(overrides: Record<string, unknown> = {}): any {
  return {
    generatePreview: vi.fn().mockResolvedValue({ ok: true, run_id: 'r-mock', finalPrompt: 'mock prompt' }),
    generatePreviewLive: vi.fn().mockResolvedValue({ ok: true, run_id: 'r-live', finalPrompt: 'live prompt' }),
    ...overrides,
  };
}

describe('composer mode state', () => {
  test('composerModeState defaults to mock and hides live-only controls', () => {
    const state = FlashSettings.composerModeState('mock');
    expect(state.mode).toBe('mock');
    expect(state.showLiveControls).toBe(false);
  });

  test('composerModeState reveals live-only controls when live is selected', () => {
    const state = FlashSettings.composerModeState('live');
    expect(state.mode).toBe('live');
    expect(state.showLiveControls).toBe(true);
  });

  test('composerModeState treats unknown values as mock (safe default)', () => {
    expect(FlashSettings.composerModeState(undefined).mode).toBe('mock');
    expect(FlashSettings.composerModeState('anything-else').showLiveControls).toBe(false);
  });
});

describe('composer key status', () => {
  test('composerKeyStatus reports configured providers as yes and never shows a value', () => {
    const status = FlashSettings.composerKeyStatus(providerList(), 'openrouter');
    expect(status.hasApiKey).toBe(true);
    expect(status.apiKeyEnv).toBe('OPENROUTER_API_KEY');
    expect(status.text.toLowerCase()).toContain('yes');
    expect(status.text).not.toContain(SECRET);
  });

  test('composerKeyStatus reports unconfigured providers as no with the env name', () => {
    const status = FlashSettings.composerKeyStatus(providerList(), 'deepseek');
    expect(status.hasApiKey).toBe(false);
    expect(status.text.toLowerCase()).toContain('no');
    expect(status.text).toContain('DEEPSEEK_API_KEY');
  });
});

describe('composer preview routing — mock mode', () => {
  test('mock mode calls composer.generatePreview only', async () => {
    const composer = makeComposer();
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'mock',
      task: 'do the thing',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: providerList(),
    });

    expect(composer.generatePreview).toHaveBeenCalledTimes(1);
    expect(composer.generatePreview).toHaveBeenCalledWith('do the thing', 'detect-only', false, 'cli');
    expect(composer.generatePreviewLive).not.toHaveBeenCalled();
    expect(outcome.flashMode).toBe('mock');
    expect(outcome.blocked).toBe(false);
    expect(outcome.result).toEqual({ ok: true, run_id: 'r-mock', finalPrompt: 'mock prompt' });
  });

  test('mock mode forwards selected CodeGraph context mode to generatePreview', async () => {
    const composer = makeComposer();
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'mock',
      task: 'do the thing',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: providerList(),
      codegraphMode: 'use-existing',
    });

    expect(composer.generatePreview).toHaveBeenCalledWith('do the thing', 'use-existing', false, 'cli');
    expect(composer.generatePreviewLive).not.toHaveBeenCalled();
    expect(outcome.codegraphMode).toBe('use-existing');
  });
});

describe('composer preview routing — live mode', () => {
  test('live mode with a configured provider calls generatePreviewLive with provider/model', async () => {
    const composer = makeComposer();
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'live',
      task: 'do the live thing',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: providerList(),
    });

    expect(composer.generatePreviewLive).toHaveBeenCalledTimes(1);
    expect(composer.generatePreviewLive).toHaveBeenCalledWith(
      'do the live thing',
      'openrouter',
      'deepseek/deepseek-chat',
      'detect-only',
      false,
      'cli',
    );
    expect(composer.generatePreview).not.toHaveBeenCalled();
    expect(outcome.flashMode).toBe('live');
    expect(outcome.blocked).toBe(false);
  });

  test('live mode forwards selected CodeGraph context mode to generatePreviewLive', async () => {
    const composer = makeComposer();
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'live',
      task: 'do the live thing',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: providerList(),
      codegraphMode: 'use-existing',
    });

    expect(composer.generatePreviewLive).toHaveBeenCalledWith(
      'do the live thing',
      'openrouter',
      'deepseek/deepseek-chat',
      'use-existing',
      false,
      'cli',
    );
    expect(composer.generatePreview).not.toHaveBeenCalled();
    expect(outcome.codegraphMode).toBe('use-existing');
  });

  test('live mode with a provider that has no API key blocks with FLASH_PROVIDER_AUTH_MISSING and never calls mock', async () => {
    const composer = makeComposer();
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'live',
      task: 'do the live thing',
      provider: 'deepseek',
      model: 'deepseek-chat',
      providerList: providerList(),
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.diagnostic?.code).toBe('FLASH_PROVIDER_AUTH_MISSING');
    expect(outcome.flashMode).toBe('live');
    // Critical: no silent fallback to the mock path.
    expect(composer.generatePreview).not.toHaveBeenCalled();
    expect(composer.generatePreviewLive).not.toHaveBeenCalled();
  });

  test('live mode surfaces a core auth diagnostic without falling back to mock', async () => {
    const composer = makeComposer({
      generatePreviewLive: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'FLASH_PROVIDER_AUTH_MISSING', message: 'no API key', details: [] },
      }),
    });
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'live',
      task: 'live with stale key state',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat',
      providerList: providerList(),
    });

    expect(composer.generatePreviewLive).toHaveBeenCalledTimes(1);
    expect(composer.generatePreview).not.toHaveBeenCalled();
    expect(outcome.blocked).toBe(false);
    const liveResult = outcome.result as { ok: boolean; error: { code: string } };
    expect(liveResult.ok).toBe(false);
    expect(liveResult.error.code).toBe('FLASH_PROVIDER_AUTH_MISSING');
  });

  test('live mode with no provider selected blocks and does not call mock', async () => {
    const composer = makeComposer();
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'live',
      task: 'live with nothing selected',
      provider: '',
      model: '',
      providerList: providerList(),
    });

    expect(outcome.blocked).toBe(true);
    expect(composer.generatePreview).not.toHaveBeenCalled();
    expect(composer.generatePreviewLive).not.toHaveBeenCalled();
  });

  test('a blocked live diagnostic never contains an API key value', async () => {
    const leaky = providerList();
    // Even if a secret somehow rode along on the provider list, it must not surface.
    (leaky[1] as unknown as Record<string, unknown>).apiKey = SECRET;
    const composer = makeComposer();
    const outcome = await FlashSettings.runComposerPreview({
      composer,
      mode: 'live',
      task: 'leaky list',
      provider: 'deepseek',
      model: 'deepseek-chat',
      providerList: leaky,
    });

    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});
