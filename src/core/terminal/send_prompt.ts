import fs from 'fs';
import path from 'path';

import {
  buildSendMetadata,
  mirrorSendMetadataToCurrent,
  SendMetadata,
  writeSendMetadata,
  FINAL_PROMPT_RELATIVE_PATH,
} from './send_metadata.js';

export interface TerminalSendWriter {
  readonly sessionId: string;
  readonly cwd?: string;
  write(data: string): void;
}

export interface TerminalPromptSendPlan {
  pasteWrites: string[];
  enterWrite?: string;
  payload: string;
  chunkCount: number;
  chunkSize: number;
}

export interface TerminalPromptSendPlanOptions {
  chunkSize?: number;
  appendNewline?: string;
}

export const BRACKETED_PASTE_START = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';
export const DEFAULT_TERMINAL_PASTE_CHUNK_SIZE = 2048;
export const DEFAULT_TERMINAL_PASTE_CHUNK_DELAY_MS = 10;
export const DEFAULT_TERMINAL_PASTE_ENTER_DELAY_MS = 75;

export interface SendPromptOptions {
  /** Absolute path to the run directory `.vibecode/runs/<run_id>/`. */
  runDir: string;
  /** Writer that delivers bytes to the active PTY session. */
  writer: TerminalSendWriter;
  /** Optional `.vibecode/` directory; when provided, mirror metadata to current/ on success. */
  vibecodePath?: string;
  /**
   * If set, append this string to the bytes written to the writer after the full
   * bracketed paste payload is delivered. The original file content is never
   * mutated. The metadata records the difference via `newline_appended` and
   * `sent_payload_sha256` so the artifact is honest.
   */
  appendNewline?: string;
  /** Optional per-send chunk size override for the bracketed paste payload. */
  chunkSize?: number;
  /** Optional delay between paste chunks in milliseconds. */
  chunkDelayMs?: number;
  /** Optional delay before sending Enter/newline after the paste payload. */
  enterDelayMs?: number;
  /**
   * Optional run id override. When omitted, the run id is derived from the
   * basename of runDir (matches the workspace layout).
   */
  runId?: string;
  /**
   * Records whether this send was auto-approved (sent without a manual approval
   * click). Honestly captured in send_metadata.json; defaults to false.
   */
  autoApprove?: boolean;
}

export interface SendPromptError {
  code: string;
  message: string;
  path?: string;
  details: string[];
}

export interface SendPromptSuccess {
  ok: true;
  run_id: string;
  metadata: SendMetadata;
  metadataPath: string;
  currentMetadataPath?: string;
}

export interface SendPromptFailure {
  ok: false;
  error: SendPromptError;
}

export type SendPromptResult = SendPromptSuccess | SendPromptFailure;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let newlineCount = 0;
  for (const ch of text) {
    if (ch === '\n') {
      newlineCount += 1;
    }
  }

  if (text.endsWith('\n')) {
    return newlineCount;
  }

  return newlineCount + 1;
}

export function planTerminalPromptSend(
  content: string,
  options: TerminalPromptSendPlanOptions = {},
): TerminalPromptSendPlan {
  const requestedChunkSize = options.chunkSize ?? DEFAULT_TERMINAL_PASTE_CHUNK_SIZE;
  const chunkSize = Math.max(1, Math.floor(requestedChunkSize));
  const appendNewline = options.appendNewline;
  const bracketedPastePayload = BRACKETED_PASTE_START + content + BRACKETED_PASTE_END;
  const pasteWrites: string[] = [];

  if (content.length === 0) {
    pasteWrites.push(bracketedPastePayload);
  } else {
    const contentChunks: string[] = [];
    for (let index = 0; index < content.length; index += chunkSize) {
      contentChunks.push(content.slice(index, index + chunkSize));
    }

    if (contentChunks.length === 0) {
      contentChunks.push('');
    }

    contentChunks[0] = BRACKETED_PASTE_START + contentChunks[0]!;
    contentChunks[contentChunks.length - 1] = contentChunks[contentChunks.length - 1]! + BRACKETED_PASTE_END;
    pasteWrites.push(...contentChunks);
  }

  return {
    pasteWrites,
    enterWrite: appendNewline && appendNewline.length > 0 ? appendNewline : undefined,
    payload: bracketedPastePayload + (appendNewline ?? ''),
    chunkCount: pasteWrites.length,
    chunkSize,
  };
}

export async function sendFinalPrompt(opts: SendPromptOptions): Promise<SendPromptResult> {
  const runId = opts.runId ?? path.basename(opts.runDir);
  const finalPromptPath = path.join(opts.runDir, FINAL_PROMPT_RELATIVE_PATH);

  if (!fs.existsSync(finalPromptPath)) {
    return {
      ok: false,
      error: {
        code: 'FINAL_PROMPT_NOT_FOUND',
        message: `final_prompt.md not found for run ${runId}`,
        path: finalPromptPath,
        details: [`Expected file at: ${finalPromptPath}`],
      },
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(finalPromptPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'FINAL_PROMPT_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
        path: finalPromptPath,
        details: [],
      },
    };
  }

  const plan = planTerminalPromptSend(content, {
    chunkSize: opts.chunkSize,
    appendNewline: opts.appendNewline,
  });
  const chunkDelayMs = opts.chunkDelayMs ?? DEFAULT_TERMINAL_PASTE_CHUNK_DELAY_MS;
  const enterDelayMs = opts.enterDelayMs ?? DEFAULT_TERMINAL_PASTE_ENTER_DELAY_MS;

  try {
    for (let index = 0; index < plan.pasteWrites.length; index += 1) {
      opts.writer.write(plan.pasteWrites[index]!);
      if (index < plan.pasteWrites.length - 1) {
        await sleep(chunkDelayMs);
      }
    }

    if (plan.enterWrite !== undefined) {
      await sleep(enterDelayMs);
      opts.writer.write(plan.enterWrite);
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'TERMINAL_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: [],
      },
    };
  }

  const meta = buildSendMetadata({
    run_id: runId,
    terminal_session_id: opts.writer.sessionId,
    content,
    payload: plan.payload,
    sentAt: new Date().toISOString(),
    newline_appended: plan.enterWrite !== undefined,
    lines: countLines(content),
    chunk_count: plan.chunkCount,
    chunk_size: plan.chunkSize,
    enter_sent_after_paste: plan.enterWrite !== undefined,
    terminal_cwd: opts.writer.cwd,
    auto_approve: opts.autoApprove ?? false,
  });

  const metadataPath = writeSendMetadata(opts.runDir, meta);
  let currentMetadataPath: string | undefined;
  if (opts.vibecodePath) {
    currentMetadataPath = mirrorSendMetadataToCurrent(opts.vibecodePath, meta);
  }

  return {
    ok: true,
    run_id: runId,
    metadata: meta,
    metadataPath,
    currentMetadataPath,
  };
}
