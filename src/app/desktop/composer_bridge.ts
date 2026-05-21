import { generatePromptPreview, PromptPreviewResult } from './prompt_preview_service.js';
import {
  sendFinalPromptForRun,
  SendPromptIpcResult,
  DesktopTerminalServiceLike,
} from './prompt_send_service.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface ComposerBridgeOptions {
  getRepoPath: () => string;
  getTerminalService?: () => DesktopTerminalServiceLike | undefined;
  previewService?: (request: { task: string; repoRoot: string }) => Promise<PromptPreviewResult>;
  sendService?: (request: {
    runId: string;
    repoRoot: string;
    terminalService: DesktopTerminalServiceLike;
  }) => Promise<SendPromptIpcResult>;
}

function noActiveTerminal(): SendPromptIpcResult {
  return {
    ok: false,
    error: {
      code: 'NO_ACTIVE_TERMINAL',
      message: 'no active terminal session is available to receive the prompt',
      details: ['Start a terminal session in the desktop shell before sending.'],
    },
  };
}

export function registerDesktopComposerIpcHandlers(
  ipcMain: IpcMainLike,
  options: ComposerBridgeOptions,
): void {
  const invokePreview = options.previewService ?? generatePromptPreview;
  const invokeSend = options.sendService ?? sendFinalPromptForRun;

  ipcMain.handle('composer:generatePreview', async (_event, ...args: unknown[]) => {
    const task = typeof args[0] === 'string' ? args[0] : '';
    const repoRoot = options.getRepoPath();
    return invokePreview({ task, repoRoot });
  });

  ipcMain.handle('composer:sendPreview', async (_event, ...args: unknown[]) => {
    const runId = typeof args[0] === 'string' ? args[0] : '';
    const repoRoot = options.getRepoPath();
    const terminalService = options.getTerminalService?.();
    if (!terminalService) {
      return noActiveTerminal();
    }
    return invokeSend({ runId, repoRoot, terminalService });
  });
}
