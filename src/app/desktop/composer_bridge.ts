import { generatePromptPreview, PromptPreviewResult } from './prompt_preview_service.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface ComposerBridgeOptions {
  getRepoPath: () => string;
  service?: (request: { task: string; repoRoot: string }) => Promise<PromptPreviewResult>;
}

export function registerDesktopComposerIpcHandlers(
  ipcMain: IpcMainLike,
  options: ComposerBridgeOptions,
): void {
  const invoke = options.service ?? generatePromptPreview;

  ipcMain.handle('composer:generatePreview', async (_event, ...args: unknown[]) => {
    const task = typeof args[0] === 'string' ? args[0] : '';
    const repoRoot = options.getRepoPath();
    return invoke({ task, repoRoot });
  });
}
