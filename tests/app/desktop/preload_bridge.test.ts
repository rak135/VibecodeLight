type ExposedApi = {
  terminal: Record<string, unknown>;
  workspace: Record<string, unknown>;
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

  test('exposes only allowed terminal and workspace APIs', async () => {
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
    expect(Object.keys(api).sort()).toEqual(['terminal', 'workspace']);
    expect(Object.keys(api.terminal).sort()).toEqual(['close', 'onData', 'onExit', 'resize', 'start', 'write']);
    expect(Object.keys(api.workspace).sort()).toEqual(['getInfo']);
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
    expect(collectKeys(api)).not.toEqual(expect.arrayContaining(['require', 'eval', 'spawn', 'fs', 'child_process']));
  });
});
