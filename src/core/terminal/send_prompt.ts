import fs from 'fs';
import path from 'path';

import {
  buildSendMetadata,
  mirrorSendMetadataToCurrent,
  SendMetadata,
  writeSendMetadata,
  FINAL_PROMPT_RELATIVE_PATH,
} from './send_metadata.js';
import { writeTerminalExcerptAfter } from './terminal_excerpt_after.js';

export interface TerminalSendWriter {
  readonly sessionId: string;
  readonly cwd?: string;
  write(data: string): void;
}

export interface SendPromptOptions {
  /** Absolute path to the run directory `.vibecode/runs/<run_id>/`. */
  runDir: string;
  /** Writer that delivers bytes to the active PTY session. */
  writer: TerminalSendWriter;
  /** Optional `.vibecode/` directory; when provided, mirror metadata to current/ on success. */
  vibecodePath?: string;
  /**
   * If set, append this string to the bytes written to the writer. The original
   * file content is never mutated. The metadata records the difference via
   * `newline_appended` and `sent_payload_sha256` so the artifact is honest.
   */
  appendNewline?: string;
  /**
   * Optional run id override. When omitted, the run id is derived from the
   * basename of runDir (matches the workspace layout).
   */
  runId?: string;
  /**
   * Optional terminal output excerpt captured after send.
   * When provided and non-empty, written to terminal/terminal_excerpt_after.md (clean, bounded).
   * When absent or empty, terminal_excerpt_after.md is not written.
   */
  terminalExcerpt?: string;
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
  /** Path to terminal_excerpt_after.md if it was written, otherwise undefined. */
  excerptPath?: string;
}

export interface SendPromptFailure {
  ok: false;
  error: SendPromptError;
}

export type SendPromptResult = SendPromptSuccess | SendPromptFailure;

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

  const payload = opts.appendNewline ? content + opts.appendNewline : content;

  try {
    opts.writer.write(payload);
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
    payload,
    sentAt: new Date().toISOString(),
    terminal_cwd: opts.writer.cwd,
  });

  const metadataPath = writeSendMetadata(opts.runDir, meta);
  let currentMetadataPath: string | undefined;
  if (opts.vibecodePath) {
    currentMetadataPath = mirrorSendMetadataToCurrent(opts.vibecodePath, meta);
  }

  let excerptPath: string | undefined;
  if (opts.terminalExcerpt && opts.terminalExcerpt.length > 0) {
    excerptPath = writeTerminalExcerptAfter(opts.runDir, opts.terminalExcerpt);
  }

  return {
    ok: true,
    run_id: runId,
    metadata: meta,
    metadataPath,
    currentMetadataPath,
    excerptPath,
  };
}
