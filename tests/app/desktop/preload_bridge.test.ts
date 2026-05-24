type ExposedApi = {
  terminal: Record<string, unknown>;
  workspace: Record<string, unknown>;
  composer: Record<string, unknown>;
  runs: Record<string, unknown>;
  config: Record<string, unknown>;
  artifacts: Record<string, unknown>;
};

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];

  const keys: string[] = [];
  for (const key of Object.keys(value)) {
    keys.push(key);
    keys.push(...collectKeys((value as Record<string, unknown>)[key]));
  }
  return keys;
}

describe('desktop preload bridge boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('exposes only allowed terminal, workspace, and composer APIs', async () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [apiName, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    expect(apiName).toBe('vibecodeAPI');
    expect(Object.keys(api).sort()).toEqual(['artifacts', 'composer', 'config', 'runs', 'terminal', 'workspace']);
    expect(Object.keys(api.terminal).sort()).toEqual(['close', 'onData', 'onExit', 'resize', 'start', 'write']);
    expect(Object.keys(api.workspace).sort()).toEqual(['getInfo']);
    expect(Object.keys(api.composer).sort()).toEqual(['generatePreview', 'generatePreviewLive', 'sendPreview']);
    expect(Object.keys(api.runs).sort()).toEqual(['list', 'show']);
    expect(Object.keys(api.config).sort()).toEqual(['getPaths', 'initLocal', 'models', 'openDir', 'providers', 'show', 'syncFromGlobal']);
    expect(Object.keys(api.artifacts).sort()).toEqual(['copyToClipboard', 'openPath']);
  });

  test("renderer-facing API does not expose forbidden keys", async () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    expect(collectKeys(api)).not.toEqual(
      expect.arrayContaining(['require', 'eval', 'spawn', 'fs', 'child_process', 'readFile', 'writeFile']),
    );
  });

  test('composer.generatePreview invokes composer:generatePreview IPC channel only', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ ok: true }),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    const composer = api.composer as { generatePreview: (task: string) => Promise<unknown> };
    await composer.generatePreview('integration smoke');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('composer:generatePreview', 'integration smoke');
  });

  test('composer.generatePreviewLive forwards live mode with provider/model over the same channel', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ ok: true }),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    const composer = api.composer as {
      generatePreviewLive: (task: string, provider?: string, model?: string) => Promise<unknown>;
    };
    await composer.generatePreviewLive('live smoke', 'openrouter', 'deepseek/deepseek-chat');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'composer:generatePreview',
      'live smoke',
      'live',
      'openrouter',
      'deepseek/deepseek-chat',
    );
  });

  test('composer.sendPreview invokes composer:sendPreview IPC channel only', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ ok: true }),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    const composer = api.composer as { sendPreview: (runId: string) => Promise<unknown> };
    await composer.sendPreview('2026-05-20_001');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('composer:sendPreview', '2026-05-20_001');
  });

  test('runs.list invokes runs:list IPC channel only', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ ok: true, runs: [] }),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    const runs = api.runs as { list: () => Promise<unknown> };
    await runs.list();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('runs:list');
  });

  test('runs.show invokes runs:show IPC channel with the run id', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ ok: true }),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    const runs = api.runs as { show: (runId: string) => Promise<unknown> };
    await runs.show('2026-05-20_001');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('runs:show', '2026-05-20_001');
  });
});
