import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildSendMetadata,
  writeSendMetadata,
  mirrorSendMetadataToCurrent,
  SEND_METADATA_RELATIVE_PATH,
} from '../../../src/core/terminal/send_metadata.js';

describe('send_metadata module', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-send-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('SEND_METADATA_RELATIVE_PATH is the canonical artifact location', () => {
    expect(SEND_METADATA_RELATIVE_PATH).toBe('terminal/send_metadata.json');
  });

  test('buildSendMetadata fills required fields and records honest payload contract', () => {
    const meta = buildSendMetadata({
      run_id: '2026-05-20_001',
      terminal_session_id: 'desktop-42-abc',
      content: '# Task\nhello\n',
      payload: '\u001b[200~# Task\nhello\n\u001b[201~\r',
      sentAt: '2026-05-20T12:00:00.000Z',
      newline_appended: true,
      lines: 3,
      chunk_count: 2,
      chunk_size: 2048,
      enter_sent_after_paste: true,
      terminal_cwd: 'C:/repo',
    });

    expect(meta.run_id).toBe('2026-05-20_001');
    expect(meta.terminal_session_id).toBe('desktop-42-abc');
    expect(meta.sent_file).toBe('output/final_prompt.md');
    expect(meta.sent_at).toBe('2026-05-20T12:00:00.000Z');
    expect(meta.auto_approve).toBe(false);
    expect(meta.byte_count).toBe(Buffer.byteLength('# Task\nhello\n', 'utf8'));
    expect(meta.char_count).toBe('# Task\nhello\n'.length);
    expect(meta.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.sent_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.content_sha256).not.toBe(meta.sent_payload_sha256);
    expect(meta.newline_appended).toBe(true);
    expect(meta.transfer_mode).toBe('bracketed_paste_chunked');
    expect(meta.bytes).toBe(Buffer.byteLength('# Task\nhello\n', 'utf8'));
    expect(meta.lines).toBe(3);
    expect(meta.chunk_count).toBe(2);
    expect(meta.chunk_size).toBe(2048);
    expect(meta.enter_sent_after_paste).toBe(true);
    expect(meta.bracketed_paste).toBe(true);
    expect(meta.terminal_cwd).toBe('C:/repo');
  });

  test('buildSendMetadata reports newline_appended=false when payload has no trailing Enter', () => {
    const text = 'identical bytes';
    const meta = buildSendMetadata({
      run_id: 'r',
      terminal_session_id: 's',
      content: text,
      payload: '\u001b[200~identical bytes\u001b[201~',
      sentAt: '2026-05-20T12:00:00.000Z',
      newline_appended: false,
      lines: 1,
      chunk_count: 1,
      chunk_size: 2048,
      enter_sent_after_paste: false,
    });
    expect(meta.newline_appended).toBe(false);
    expect(meta.content_sha256).not.toBe(meta.sent_payload_sha256);
    expect(meta.terminal_cwd).toBeUndefined();
  });

  test('writeSendMetadata persists JSON under terminal/send_metadata.json in the run folder', () => {
    const runDir = path.join(tmpRoot, 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });

    const meta = buildSendMetadata({
      run_id: 'r1',
      terminal_session_id: 's',
      content: 'abc',
      payload: '\u001b[200~abc\u001b[201~',
      sentAt: '2026-05-20T12:00:00.000Z',
      newline_appended: false,
      lines: 1,
      chunk_count: 1,
      chunk_size: 2048,
      enter_sent_after_paste: false,
    });

    const written = writeSendMetadata(runDir, meta);

    expect(written).toBe(path.join(runDir, 'terminal', 'send_metadata.json'));
    expect(fs.existsSync(written)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
    expect(parsed.run_id).toBe('r1');
    expect(parsed.sent_file).toBe('output/final_prompt.md');
    expect(parsed.auto_approve).toBe(false);
  });

  test('mirrorSendMetadataToCurrent writes only to .vibecode/current/send_metadata.json', () => {
    const vibecodePath = path.join(tmpRoot, '.vibecode');
    fs.mkdirSync(vibecodePath, { recursive: true });

    const meta = buildSendMetadata({
      run_id: 'r1',
      terminal_session_id: 's',
      content: 'abc',
      payload: '\u001b[200~abc\u001b[201~',
      sentAt: '2026-05-20T12:00:00.000Z',
      newline_appended: false,
      lines: 1,
      chunk_count: 1,
      chunk_size: 2048,
      enter_sent_after_paste: false,
    });

    const mirroredPath = mirrorSendMetadataToCurrent(vibecodePath, meta);

    expect(mirroredPath).toBe(path.join(vibecodePath, 'current', 'send_metadata.json'));
    expect(fs.existsSync(mirroredPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(mirroredPath, 'utf8'));
    expect(parsed.run_id).toBe('r1');
  });
});
