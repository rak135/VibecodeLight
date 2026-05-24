import { Buffer } from 'buffer';
import fs from 'fs';
import path from 'path';

import { sha256 } from './hash.js';

export const SEND_METADATA_RELATIVE_PATH = 'terminal/send_metadata.json';
export const FINAL_PROMPT_RELATIVE_PATH = 'output/final_prompt.md';

export interface SendMetadata {
  run_id: string;
  terminal_session_id: string;
  sent_file: string;
  sent_at: string;
  auto_approve: boolean;
  byte_count: number;
  char_count: number;
  bytes: number;
  lines: number;
  content_sha256: string;
  sent_payload_sha256: string;
  newline_appended: boolean;
  transfer_mode: 'bracketed_paste_chunked';
  chunk_count: number;
  chunk_size: number;
  enter_sent_after_paste: boolean;
  bracketed_paste: true;
  terminal_cwd?: string;
}

export interface BuildSendMetadataInput {
  run_id: string;
  terminal_session_id: string;
  content: string;
  payload: string;
  sentAt: string;
  newline_appended: boolean;
  lines: number;
  chunk_count: number;
  chunk_size: number;
  enter_sent_after_paste: boolean;
  terminal_cwd?: string;
  /** True when the prompt was sent without a manual approval click. Defaults to false. */
  auto_approve?: boolean;
}

export function buildSendMetadata(input: BuildSendMetadataInput): SendMetadata {
  const contentHash = sha256(input.content);
  const payloadHash = sha256(input.payload);

  const meta: SendMetadata = {
    run_id: input.run_id,
    terminal_session_id: input.terminal_session_id,
    sent_file: FINAL_PROMPT_RELATIVE_PATH,
    sent_at: input.sentAt,
    auto_approve: input.auto_approve ?? false,
    byte_count: Buffer.byteLength(input.content, 'utf8'),
    char_count: input.content.length,
    bytes: Buffer.byteLength(input.content, 'utf8'),
    lines: input.lines,
    content_sha256: contentHash,
    sent_payload_sha256: payloadHash,
    newline_appended: input.newline_appended,
    transfer_mode: 'bracketed_paste_chunked',
    chunk_count: input.chunk_count,
    chunk_size: input.chunk_size,
    enter_sent_after_paste: input.enter_sent_after_paste,
    bracketed_paste: true,
  };

  if (input.terminal_cwd !== undefined) {
    meta.terminal_cwd = input.terminal_cwd;
  }

  return meta;
}

export function writeSendMetadata(runDir: string, meta: SendMetadata): string {
  const destination = path.join(runDir, SEND_METADATA_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return destination;
}

export function mirrorSendMetadataToCurrent(vibecodePath: string, meta: SendMetadata): string {
  const currentDir = path.join(vibecodePath, 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  const destination = path.join(currentDir, 'send_metadata.json');
  fs.writeFileSync(destination, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return destination;
}
