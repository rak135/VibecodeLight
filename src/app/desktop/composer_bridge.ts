import { generatePromptPreview } from './prompt_preview_service.js';
import type { PromptPreviewResult, PipelineProgressEvent } from './prompt_preview_service.js';
import {
  sendFinalPromptForRun,
  SendPromptIpcResult,
  DesktopTerminalServiceLike,
} from './prompt_send_service.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface IpcEventWithSender {
  sender?: {
    send(channel: string, event: SafePipelineProgressEvent): void;
  };
}

export type SafePipelineProgressEvent = Pick<
  PipelineProgressEvent,
  'phase' | 'message' | 'run_id' | 'provider_id' | 'model_id' | 'elapsed_ms' | 'artifact_path' | 'chunk'
>;

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function toSafePipelineProgressEvent(event: PipelineProgressEvent): SafePipelineProgressEvent {
  const source = event as unknown as Record<string, unknown>;
  const safe: SafePipelineProgressEvent = {
    phase: event.phase,
    message: safeString(source.message) ?? '',
  };
  const runId = safeString(source.run_id);
  const providerId = safeString(source.provider_id);
  const modelId = safeString(source.model_id);
  const elapsedMs = safeNumber(source.elapsed_ms);
  const artifactPath = safeString(source.artifact_path);
  const chunk = safeString(source.chunk);
  if (runId !== undefined) safe.run_id = runId;
  if (providerId !== undefined) safe.provider_id = providerId;
  if (modelId !== undefined) safe.model_id = modelId;
  if (elapsedMs !== undefined) safe.elapsed_ms = elapsedMs;
  if (artifactPath !== undefined) safe.artifact_path = artifactPath;
  if (chunk !== undefined) safe.chunk = chunk;
  return safe;
}

export interface ComposerBridgeOptions {
  getRepoPath: () => string;
  getTerminalService?: () => DesktopTerminalServiceLike | undefined;
  previewService?: (request: {
    task: string;
    repoRoot: string;
    flashMode?: 'mock' | 'live';
    flashProvider?: string;
    flashModel?: string;
    onProgress?: (event: PipelineProgressEvent) => void;
  }) => Promise<PromptPreviewResult>;
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

  ipcMain.handle('composer:generatePreview', async (event, ...args: unknown[]) => {
    const task = typeof args[0] === 'string' ? args[0] : '';
    const flashMode = (args[1] === 'live' ? 'live' : 'mock') as 'mock' | 'live';
    const flashProvider = typeof args[2] === 'string' ? args[2] : undefined;
    const flashModel = typeof args[3] === 'string' ? args[3] : undefined;
    const repoRoot = options.getRepoPath();
    const sender = (event as IpcEventWithSender | undefined)?.sender;
    return invokePreview({
      task,
      repoRoot,
      flashMode,
      flashProvider,
      flashModel,
      onProgress: (pipelineEvent) => {
        sender?.send('composer:progress', toSafePipelineProgressEvent(pipelineEvent));
      },
    });
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
