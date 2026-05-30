import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

describe('desktop composer task normalizer wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('generatePreview IPC call passes taskNormalizerEnabled=true when args[5]=true', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeIpc();
    const previewService = vi.fn().mockResolvedValue({ ok: false, error: { code: 'STOPPED_BY_TEST', message: 'done', details: [] } });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender: { send: vi.fn() } }, 'do work', 'mock', undefined, undefined, 'detect-only', true);

    expect(previewService).toHaveBeenCalledWith(expect.objectContaining({
      task: 'do work',
      codegraphMode: 'detect-only',
      taskNormalizerEnabled: true,
    }));
  });

  test('generatePreview IPC call defaults taskNormalizerEnabled to false when args[5] is missing', async () => {
    const { registerDesktopComposerIpcHandlers } = await import('../../../src/app/desktop/composer_bridge.js');
    const ipc = createFakeIpc();
    const previewService = vi.fn().mockResolvedValue({ ok: false, error: { code: 'STOPPED_BY_TEST', message: 'done', details: [] } });

    registerDesktopComposerIpcHandlers(ipc, {
      getRepoPath: () => '/repo',
      previewService,
    });

    await ipc.invoke('composer:generatePreview', { sender: { send: vi.fn() } }, 'do work', 'live', 'openrouter', 'deepseek-chat', 'use-existing');

    expect(previewService).toHaveBeenCalledWith(expect.objectContaining({
      task: 'do work',
      codegraphMode: 'use-existing',
      taskNormalizerEnabled: false,
    }));
  });

  test('prompt_preview_service passes taskNormalizerEnabled to pipeline and exposes task intent fields', async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-preview-task-normalizer-'));
    const runDir = path.join(tmpRepo, '.vibecode', 'runs', '20260530_000001');
    const finalPromptPath = path.join(runDir, 'output', 'final_prompt.md');
    fs.mkdirSync(path.dirname(finalPromptPath), { recursive: true });
    fs.writeFileSync(finalPromptPath, '# Final Prompt\n', 'utf8');

    const runPromptPipeline = vi.fn().mockResolvedValue({
      ok: true,
      run_id: '20260530_000001',
      runDir,
      finalPromptPath,
      taskNormalizerEnabled: true,
      taskNormalizerOk: true,
      taskNormalizerLanguage: 'cs',
      taskIntentPath: path.join(runDir, 'task_intent.json'),
      artifacts: [],
      warnings: [],
    });
    vi.doMock('../../../src/core/prompting/pipeline.js', () => ({ runPromptPipeline }));

    try {
      const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
      const result = await generatePromptPreview({ task: 'normalize desktop preview', repoRoot: tmpRepo, taskNormalizerEnabled: true });

      expect(runPromptPipeline).toHaveBeenCalledWith(expect.objectContaining({ taskNormalizerEnabled: true }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.taskNormalizerEnabled).toBe(true);
      expect(result.taskNormalizerOk).toBe(true);
      expect(result.taskNormalizerLanguage).toBe('cs');
      expect(result.taskIntentPath).toBe(path.join(runDir, 'task_intent.json'));
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});