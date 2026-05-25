import fs from 'fs';
import path from 'path';

import { sendFinalPrompt, SendPromptResult } from '../../core/terminal/send_prompt.js';
import type { SendMetadata } from '../../core/terminal/send_metadata.js';

export interface DesktopActiveSession {
  sessionId: string;
  cwd: string;
  pid: number;
  shell: string;
}

export interface DesktopTerminalServiceLike {
  writeInput(sessionId: string, data: string): void;
  getActiveSessionInfo(): DesktopActiveSession | undefined;
  getSession?(sessionId: string): DesktopActiveSession | undefined;
}

export interface SendPromptIpcSuccess {
  ok: true;
  run_id: string;
  runDir: string;
  sentAt: string;
  metadata: SendMetadata;
  sendMetadataPath: string;
  currentSendMetadataPath: string;
  terminalSend: 'sent';
}

export interface SendPromptIpcError {
  ok: false;
  error: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

export type SendPromptIpcResult = SendPromptIpcSuccess | SendPromptIpcError;

export interface SendPromptForRunRequest {
  runId: string;
  repoRoot: string;
  terminalService: DesktopTerminalServiceLike;
  targetSessionId?: string;
  /** When true, the send was auto-approved (no manual approval click). Defaults to false. */
  autoApprove?: boolean;
}

function errorResult(code: string, message: string, pathValue?: string, details: string[] = []): SendPromptIpcError {
  const error: SendPromptIpcError['error'] = { code, message, details };
  if (pathValue !== undefined) error.path = pathValue;
  return { ok: false, error };
}

function resolveTarget(
  service: DesktopTerminalServiceLike,
  targetSessionId: string | undefined,
): { ok: true; session: DesktopActiveSession } | { ok: false; error: SendPromptIpcError } {
  if (targetSessionId && targetSessionId.length > 0) {
    const found = service.getSession?.(targetSessionId);
    if (!found) {
      return {
        ok: false,
        error: errorResult(
          'ORIGIN_TERMINAL_CLOSED',
          `target terminal session ${targetSessionId} is no longer available`,
          undefined,
          ['The terminal session that started this composer has exited; open the composer from a live terminal and send again.'],
        ),
      };
    }
    return { ok: true, session: found };
  }
  const active = service.getActiveSessionInfo();
  if (!active) {
    return {
      ok: false,
      error: errorResult(
        'NO_ACTIVE_TERMINAL',
        'no active terminal session is available to receive the prompt',
        undefined,
        ['Start a terminal session in the desktop shell before sending.'],
      ),
    };
  }
  return { ok: true, session: active };
}

export async function sendFinalPromptForRun(req: SendPromptForRunRequest): Promise<SendPromptIpcResult> {
  const runId = (req.runId ?? '').trim();
  if (runId.length === 0) {
    return errorResult('RUN_ID_REQUIRED', 'run id is required to send a prompt');
  }

  const repoRoot = req.repoRoot;
  if (!repoRoot || typeof repoRoot !== 'string') {
    return errorResult('REPO_ROOT_REQUIRED', 'repoRoot is required to send a prompt');
  }

  const vibecodePath = path.join(repoRoot, '.vibecode');
  const runDir = path.join(vibecodePath, 'runs', runId);

  if (!fs.existsSync(runDir)) {
    return errorResult('RUN_NOT_FOUND', `run not found: ${runId}`, runDir, [
      `Expected run directory at: ${runDir}`,
    ]);
  }

  const targetResolution = resolveTarget(req.terminalService, req.targetSessionId);
  if (!targetResolution.ok) return targetResolution.error;
  const target = targetResolution.session;

  const writer = {
    sessionId: target.sessionId,
    cwd: target.cwd,
    write: (data: string) => {
      const stillAvailable = req.terminalService.getSession?.(target.sessionId);
      if (req.terminalService.getSession && !stillAvailable) {
        throw new Error(`target terminal session ${target.sessionId} is no longer available`);
      }
      req.terminalService.writeInput(target.sessionId, data);
    },
  };

  const result: SendPromptResult = await sendFinalPrompt({
    runDir,
    writer,
    vibecodePath,
    runId,
    appendNewline: '\r',
    autoApprove: req.autoApprove ?? false,
  });

  if (!result.ok) {
    const errPath = result.error.path;
    const errOut: SendPromptIpcError['error'] = {
      code: result.error.code,
      message: result.error.message,
      details: result.error.details,
    };
    if (errPath !== undefined) errOut.path = errPath;
    return { ok: false, error: errOut };
  }

  return {
    ok: true,
    run_id: result.run_id,
    runDir,
    sentAt: result.metadata.sent_at,
    metadata: result.metadata,
    sendMetadataPath: result.metadataPath,
    currentSendMetadataPath: result.currentMetadataPath ?? path.join(vibecodePath, 'current', 'send_metadata.json'),
    terminalSend: 'sent',
  };
}
