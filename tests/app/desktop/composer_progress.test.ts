interface CapturedIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  invoke(channel: string, event: unknown, ...args: unknown[]): unknown;
}

function createFakeIpc(): CapturedIpc {
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

describe('desktop composer progress IPC', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('registerDesktopComposerIpcHandlers forwards progress events during preview generation', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeIpc();
    const sender = { send: vi.fn() };
    const previewService = vi.fn(async (request) => {
      request.onProgress?.({ phase: 'scan_started', message: 'Scanning repository context.', elapsed_ms: 1 });
      request.onProgress?.({
        phase: 'provider_resolved',
        message: 'Flash provider resolved.',
        provider_id: 'openrouter',
        model_id: 'deepseek-chat',
        elapsed_ms: 2,
      });
      return {
        ok: false as const,
        error: { code: 'STOPPED_BY_TEST', message: 'done', details: [] },
      };
    });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender }, 'do work', 'live', 'openrouter', 'deepseek-chat');

    expect(previewService).toHaveBeenCalledWith(expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(sender.send).toHaveBeenCalledWith('composer:progress', {
      phase: 'scan_started',
      message: 'Scanning repository context.',
      elapsed_ms: 1,
    });
    expect(sender.send).toHaveBeenCalledWith('composer:progress', {
      phase: 'provider_resolved',
      message: 'Flash provider resolved.',
      provider_id: 'openrouter',
      model_id: 'deepseek-chat',
      elapsed_ms: 2,
    });
  });

  test('pipeline_warning event preserves label, message, detail, and artifact_path across IPC', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeIpc();
    const sender = { send: vi.fn() };
    const previewService = vi.fn(async (request) => {
      request.onProgress?.({
        phase: 'pipeline_warning',
        status: 'warning',
        label: 'Scanner',
        message: 'pnpm not available on PATH.',
        detail: 'Scanner command discovery',
        artifact_path: 'scan/commands.json',
        run_id: '2026-05-31_001',
        elapsed_ms: 5,
      });
      return {
        ok: false as const,
        error: { code: 'STOPPED_BY_TEST', message: 'done', details: [] },
      };
    });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender }, 'do work', 'mock');

    expect(sender.send).toHaveBeenCalledWith('composer:progress', {
      phase: 'pipeline_warning',
      status: 'warning',
      label: 'Scanner',
      message: 'pnpm not available on PATH.',
      detail: 'Scanner command discovery',
      artifact_path: 'scan/commands.json',
      run_id: '2026-05-31_001',
      elapsed_ms: 5,
    });
  });

  test('failed progress event forwards only safe serializable diagnostic fields', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeIpc();
    const sender = { send: vi.fn() };
    const previewService = vi.fn(async (request) => {
      request.onProgress?.({
        phase: 'failed',
        message: 'FLASH_PROVIDER_BAD_RESPONSE: [REDACTED]',
        run_id: '2026-05-24_001',
        elapsed_ms: 12,
        details: ['sk-test-secret'],
        api_key: 'sk-test-secret',
      });
      return {
        ok: false as const,
        error: { code: 'FLASH_PROVIDER_BAD_RESPONSE', message: 'bad provider response', details: [] },
      };
    });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender }, 'do work', 'live', 'openrouter', 'deepseek-chat');

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith('composer:progress', {
      phase: 'failed',
      message: 'FLASH_PROVIDER_BAD_RESPONSE: [REDACTED]',
      run_id: '2026-05-24_001',
      elapsed_ms: 12,
    });
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain('sk-test-secret');
  });
});
