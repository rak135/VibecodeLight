interface CapturedIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  invoke(channel: string, event: unknown, ...args: unknown[]): unknown;
}

function createFakeTransportIpc(): CapturedIpc {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    invoke(channel, event, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler(event, ...args);
    },
  };
}

describe('desktop composer bridge — CodeGraph transport (Phase 1B)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('forwards transport=mcp from IPC args[7] into the preview service', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeTransportIpc();
    const previewService = vi.fn().mockResolvedValue({ ok: false, error: { code: 'STOPPED_BY_TEST', message: 'done', details: [] } });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender: { send: vi.fn() } }, 'task', 'mock', undefined, undefined, 'use-existing', false, 'mcp');

    expect(previewService).toHaveBeenCalledWith(expect.objectContaining({
      task: 'task',
      codegraphMode: 'use-existing',
      codegraphTransport: 'mcp',
    }));
  });

  test('defaults transport to cli when args[7] is missing', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeTransportIpc();
    const previewService = vi.fn().mockResolvedValue({ ok: false, error: { code: 'STOPPED_BY_TEST', message: 'done', details: [] } });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender: { send: vi.fn() } }, 'task', 'mock', undefined, undefined, 'detect-only');

    expect(previewService).toHaveBeenCalledWith(expect.objectContaining({
      codegraphTransport: 'cli',
    }));
  });

  test('invalid transport value coerces to cli (defense at IPC boundary)', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeTransportIpc();
    const previewService = vi.fn().mockResolvedValue({ ok: false, error: { code: 'STOPPED_BY_TEST', message: 'done', details: [] } });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender: { send: vi.fn() } }, 'task', 'mock', undefined, undefined, 'detect-only', false, 'rubbish');

    expect(previewService).toHaveBeenCalledWith(expect.objectContaining({
      codegraphTransport: 'cli',
    }));
  });
});
