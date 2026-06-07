type ExposedApi = {
  terminal: Record<string, unknown>;
  workspace: Record<string, unknown>;
  composer: Record<string, unknown>;
  runs: Record<string, unknown>;
  config: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  codegraph: Record<string, unknown>;
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
    expect(Object.keys(api).sort()).toEqual(['artifacts', 'codegraph', 'composer', 'config', 'runs', 'skills', 'terminal', 'workspace']);
    expect(Object.keys(api.terminal).sort()).toEqual(['close', 'getPtyInfo', 'list', 'onData', 'onExit', 'onPreflight', 'resize', 'start', 'write']);
    expect(Object.keys(api.workspace).sort()).toEqual(['getInfo']);
    expect(Object.keys(api.composer).sort()).toEqual(['generatePreview', 'generatePreviewLive', 'onProgress', 'sendPreview']);
    expect(Object.keys(api.runs).sort()).toEqual(['list', 'show']);
    expect(Object.keys(api.config).sort()).toEqual([
      'applyAgentGuidanceIntegration',
      'dryRunAgentGuidanceIntegration',
      'getAgentGuidanceConfig',
      'getAgentGuidanceConfigPath',
      'getAgentGuidanceDefaults',
      'getAgentGuidanceIntegrationStatus',
      'getAgentGuidanceMcpTools',
      'getAgentGuidanceRuntimeStatus',
      'getAgentGuidanceTerminalPreflightConfig',
      'getCodeGraphTransportSetting',
      'getDesktopAutoApproveEnabledSetting',
      'getDesktopCodeGraphModeSetting',
      'getDesktopTaskNormalizerEnabledSetting',
      'getPaths',
      'initLocal',
      'models',
      'openDir',
      'providers',
      'rememberLiveSelection',
      'resetAgentGuidanceConfig',
      'resetCodeGraphTransportSetting',
      'resetDesktopAutoApproveEnabledSetting',
      'resetDesktopCodeGraphModeSetting',
      'resetDesktopTaskNormalizerEnabledSetting',
      'setAgentGuidanceConfig',
      'setAgentGuidanceTerminalPreflightConfig',
      'setCodeGraphTransportSetting',
      'setDesktopAutoApproveEnabledSetting',
      'setDesktopCodeGraphModeSetting',
      'setDesktopTaskNormalizerEnabledSetting',
      'show',
      'syncFromGlobal',
    ]);
    expect(Object.keys(api.artifacts).sort()).toEqual(['copyToClipboard', 'openPath', 'readClipboard', 'readRunArtifact']);
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

  test('terminal.getPtyInfo invokes the read-only PTY metadata IPC channel only', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 26200 } }),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    const terminal = api.terminal as { getPtyInfo: () => Promise<unknown> };
    await terminal.getPtyInfo();

    // Protected invariant: the renderer may read PTY metadata for xterm's
    // Windows ConPTY hint, but it must not gain direct process access.
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('terminal:getPtyInfo');
    expect(ipcRenderer.send).not.toHaveBeenCalled();
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
    const composer = api.composer as { generatePreview: (task: string, codegraphMode?: string) => Promise<unknown> };
    await composer.generatePreview('integration smoke');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'composer:generatePreview',
      'integration smoke',
      'mock',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [],
    );
    await composer.generatePreview('integration smoke', 'use-existing');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'composer:generatePreview',
      'integration smoke',
      'mock',
      undefined,
      undefined,
      'use-existing',
      false,
      undefined,
      [],
    );
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
      generatePreviewLive: (task: string, provider?: string, model?: string, codegraphMode?: string) => Promise<unknown>;
    };
    await composer.generatePreviewLive('live smoke', 'openrouter', 'deepseek/deepseek-chat', 'use-existing');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'composer:generatePreview',
      'live smoke',
      'live',
      'openrouter',
      'deepseek/deepseek-chat',
      'use-existing',
      false,
      undefined,
      [],
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
    const composer = api.composer as { sendPreview: (runId: string, targetSessionId?: string, autoApprove?: boolean) => Promise<unknown> };
    await composer.sendPreview('2026-05-20_001');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('composer:sendPreview', '2026-05-20_001', undefined, false);
  });

  test('composer.sendPreview forwards the autoApprove flag over IPC', async () => {
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
    const composer = api.composer as { sendPreview: (runId: string, targetSessionId?: string, autoApprove?: boolean) => Promise<unknown> };
    await composer.sendPreview('2026-05-20_001', 'origin-tile', true);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('composer:sendPreview', '2026-05-20_001', 'origin-tile', true);
  });

  test('config CodeGraph transport methods invoke only safe config IPC channels', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ ok: true, transport: 'mcp' }),
      send: vi.fn(),
      on: vi.fn(),
    };
    const contextBridge = {
      exposeInMainWorld: vi.fn(),
    };
    vi.doMock('electron', () => ({ contextBridge, ipcRenderer }));

    await import('../../../src/app/desktop/preload.js');

    const [, api] = contextBridge.exposeInMainWorld.mock.calls[0] as [string, ExposedApi];
    const config = api.config as {
      getCodeGraphTransportSetting: () => Promise<unknown>;
      setCodeGraphTransportSetting: (transport: string) => Promise<unknown>;
      resetCodeGraphTransportSetting: () => Promise<unknown>;
    };

    await config.getCodeGraphTransportSetting();
    await config.setCodeGraphTransportSetting('auto');
    await config.resetCodeGraphTransportSetting();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getCodeGraphTransportSetting');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setCodeGraphTransportSetting', 'auto');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:resetCodeGraphTransportSetting');
    expect(ipcRenderer.send).not.toHaveBeenCalled();
  });

  test('config desktop remembered setting methods invoke only safe config IPC channels', async () => {
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
    const config = api.config as {
      getDesktopCodeGraphModeSetting: () => Promise<unknown>;
      setDesktopCodeGraphModeSetting: (mode: string) => Promise<unknown>;
      resetDesktopCodeGraphModeSetting: () => Promise<unknown>;
      getDesktopTaskNormalizerEnabledSetting: () => Promise<unknown>;
      setDesktopTaskNormalizerEnabledSetting: (enabled: boolean) => Promise<unknown>;
      resetDesktopTaskNormalizerEnabledSetting: () => Promise<unknown>;
      getDesktopAutoApproveEnabledSetting: () => Promise<unknown>;
      setDesktopAutoApproveEnabledSetting: (enabled: boolean) => Promise<unknown>;
      resetDesktopAutoApproveEnabledSetting: () => Promise<unknown>;
    };

    await config.getDesktopCodeGraphModeSetting();
    await config.setDesktopCodeGraphModeSetting('use-existing');
    await config.resetDesktopCodeGraphModeSetting();
    await config.getDesktopTaskNormalizerEnabledSetting();
    await config.setDesktopTaskNormalizerEnabledSetting(true);
    await config.setDesktopTaskNormalizerEnabledSetting('true' as unknown as boolean);
    await config.resetDesktopTaskNormalizerEnabledSetting();
    await config.getDesktopAutoApproveEnabledSetting();
    await config.setDesktopAutoApproveEnabledSetting(false);
    await config.setDesktopAutoApproveEnabledSetting(1 as unknown as boolean);
    await config.resetDesktopAutoApproveEnabledSetting();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getDesktopCodeGraphModeSetting');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setDesktopCodeGraphModeSetting', 'use-existing');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:resetDesktopCodeGraphModeSetting');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getDesktopTaskNormalizerEnabledSetting');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setDesktopTaskNormalizerEnabledSetting', true);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setDesktopTaskNormalizerEnabledSetting', 'true');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:resetDesktopTaskNormalizerEnabledSetting');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getDesktopAutoApproveEnabledSetting');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setDesktopAutoApproveEnabledSetting', false);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setDesktopAutoApproveEnabledSetting', 1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:resetDesktopAutoApproveEnabledSetting');
    expect(ipcRenderer.send).not.toHaveBeenCalled();
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

  test('config agent guidance methods invoke only safe config IPC channels', async () => {
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
    const config = api.config as {
      getAgentGuidanceConfig: () => Promise<unknown>;
      setAgentGuidanceConfig: (config: Record<string, unknown>) => Promise<unknown>;
      resetAgentGuidanceConfig: () => Promise<unknown>;
      getAgentGuidanceDefaults: () => Promise<unknown>;
      getAgentGuidanceConfigPath: () => Promise<unknown>;
      getAgentGuidanceMcpTools: () => Promise<unknown>;
      getAgentGuidanceRuntimeStatus: () => Promise<unknown>;
      getAgentGuidanceIntegrationStatus: (agent: string) => Promise<unknown>;
      getAgentGuidanceTerminalPreflightConfig: () => Promise<unknown>;
      setAgentGuidanceTerminalPreflightConfig: (config: Record<string, unknown>) => Promise<unknown>;
      dryRunAgentGuidanceIntegration: (agent: string) => Promise<unknown>;
      applyAgentGuidanceIntegration: (agent: string, confirmed: boolean) => Promise<unknown>;
    };

    const payload = { schema_version: 1, enabled: false, default_guidance: 'x' };
    await config.getAgentGuidanceConfig();
    await config.setAgentGuidanceConfig(payload);
    await config.resetAgentGuidanceConfig();
    await config.getAgentGuidanceDefaults();
    await config.getAgentGuidanceConfigPath();
    await config.getAgentGuidanceMcpTools();
    await config.getAgentGuidanceRuntimeStatus();
    await config.getAgentGuidanceIntegrationStatus('codex');
    await config.getAgentGuidanceTerminalPreflightConfig();
    await config.setAgentGuidanceTerminalPreflightConfig({ enabled: true, mode: 'check_only' });
    await config.dryRunAgentGuidanceIntegration('claude');
    await config.applyAgentGuidanceIntegration('codex', true);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getAgentGuidanceConfig');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setAgentGuidanceConfig', payload);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:resetAgentGuidanceConfig');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getAgentGuidanceDefaults');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getAgentGuidanceConfigPath');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getAgentGuidanceMcpTools');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getAgentGuidanceRuntimeStatus');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getAgentGuidanceIntegrationStatus', 'codex');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:getAgentGuidanceTerminalPreflightConfig');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:setAgentGuidanceTerminalPreflightConfig', { enabled: true, mode: 'check_only' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:dryRunAgentGuidanceIntegration', 'claude');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('config:applyAgentGuidanceIntegration', 'codex', true);
    expect(ipcRenderer.send).not.toHaveBeenCalled();
  });

  test('agent guidance bridge does not expose any arbitrary path or file I/O API', async () => {
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
    const configKeys = Object.keys(api.config);
    const forbiddenAgentGuidanceKeys = [
      'readAgentGuidancePath',
      'writeAgentGuidancePath',
      'readArbitraryYaml',
      'openAgentGuidanceFile',
    ];
    for (const key of forbiddenAgentGuidanceKeys) {
      expect(configKeys).not.toContain(key);
    }
  });

  test('terminal preflight status listener uses receive-only IPC and adds no terminal write channel', async () => {
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
    const terminal = api.terminal as { onPreflight: (callback: (sessionId: string, result: unknown) => void) => void };
    terminal.onPreflight(vi.fn());

    expect(ipcRenderer.on).toHaveBeenCalledWith('terminal:preflight', expect.any(Function));
    expect(ipcRenderer.send).not.toHaveBeenCalled();
    expect(Object.keys(api.terminal)).not.toContain('preflightWrite');
  });
});
