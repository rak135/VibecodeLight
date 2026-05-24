import fs from 'fs';
import os from 'os';
import path from 'path';

import { planTerminalPromptSend, sendFinalPrompt } from '../../../src/core/terminal/send_prompt.js';
import { sha256 } from '../../../src/core/terminal/hash.js';

const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

interface FakeWriter {
  sessionId: string;
  cwd?: string;
  writes: string[];
  write(data: string): void;
}

function createWriter(overrides: Partial<FakeWriter> = {}): FakeWriter {
  const writes: string[] = [];
  return {
    sessionId: overrides.sessionId ?? 'desktop-1234-abc',
    cwd: overrides.cwd,
    writes,
    write(data: string) {
      writes.push(data);
      if (overrides.write) overrides.write(data);
    },
  };
}

function makeRun(tmpRoot: string, runId: string, finalPromptContent: string | null): { runDir: string; vibecodePath: string; finalPromptPath: string } {
  const vibecodePath = path.join(tmpRoot, '.vibecode');
  const runDir = path.join(vibecodePath, 'runs', runId);
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  const finalPromptPath = path.join(runDir, 'output', 'final_prompt.md');
  if (finalPromptContent !== null) {
    fs.writeFileSync(finalPromptPath, finalPromptContent, 'utf8');
  }
  return { runDir, vibecodePath, finalPromptPath };
}

describe('sendFinalPrompt', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-send-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('reads output/final_prompt.md from the run folder and sends it as one bracketed paste payload', async () => {
    const content = '# Task\n\nDo the thing.\n';
    const { runDir, finalPromptPath } = makeRun(tmpRoot, 'r1', content);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(writer.writes).toEqual([BRACKETED_PASTE_START + content + BRACKETED_PASTE_END]);

    // file must still be untouched on disk
    expect(fs.readFileSync(finalPromptPath, 'utf8')).toBe(content);
  });

  test('writes terminal/send_metadata.json after successful send with required fields', async () => {
    const content = 'payload content';
    const { runDir } = makeRun(tmpRoot, 'r2', content);
    const writer = createWriter({ sessionId: 'desktop-77-xyz', cwd: 'C:/repo' });

    const result = await sendFinalPrompt({ runDir, writer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const metadataPath = path.join(runDir, 'terminal', 'send_metadata.json');
    expect(fs.existsSync(metadataPath)).toBe(true);
    expect(result.metadataPath).toBe(metadataPath);

    const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(meta.run_id).toBe('r2');
    expect(meta.terminal_session_id).toBe('desktop-77-xyz');
    expect(meta.sent_file).toBe('output/final_prompt.md');
    expect(typeof meta.sent_at).toBe('string');
    expect(meta.sent_at.length).toBeGreaterThan(0);
    expect(meta.auto_approve).toBe(false);
    expect(meta.byte_count).toBe(Buffer.byteLength(content, 'utf8'));
    expect(meta.char_count).toBe(content.length);
    expect(meta.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.sent_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.terminal_cwd).toBe('C:/repo');
    expect(meta.transfer_mode).toBe('bracketed_paste_chunked');
    expect(meta.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(meta.lines).toBe(1);
    expect(meta.chunk_count).toBe(1);
    expect(meta.chunk_size).toBeGreaterThan(0);
    expect(meta.bracketed_paste).toBe(true);
    expect(meta.enter_sent_after_paste).toBe(false);
  });

  test('records auto_approve=true in send_metadata when the autoApprove option is set', async () => {
    const content = 'auto approved\n';
    const { runDir } = makeRun(tmpRoot, 'r-auto', content);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer, autoApprove: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.metadata.auto_approve).toBe(true);
    const meta = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
    expect(meta.auto_approve).toBe(true);
  });

  test('defaults auto_approve to false when the autoApprove option is omitted', async () => {
    const content = 'manual send\n';
    const { runDir } = makeRun(tmpRoot, 'r-manual', content);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.metadata.auto_approve).toBe(false);
  });

  test('mirrors metadata to .vibecode/current/send_metadata.json only when vibecodePath provided and only after success', async () => {
    const content = 'mirror me';
    const { runDir, vibecodePath } = makeRun(tmpRoot, 'r3', content);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer, vibecodePath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mirrored = path.join(vibecodePath, 'current', 'send_metadata.json');
    expect(fs.existsSync(mirrored)).toBe(true);
    expect(result.currentMetadataPath).toBe(mirrored);
  });

  test('does not create send_metadata.json or current mirror when writer throws', async () => {
    const { runDir, vibecodePath } = makeRun(tmpRoot, 'r4', 'payload');
    const writer = createWriter({
      write() {
        throw new Error('boom');
      },
    });

    const result = await sendFinalPrompt({ runDir, writer, vibecodePath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TERMINAL_WRITE_FAILED');

    const metadataPath = path.join(runDir, 'terminal', 'send_metadata.json');
    const mirrored = path.join(vibecodePath, 'current', 'send_metadata.json');
    expect(fs.existsSync(metadataPath)).toBe(false);
    expect(fs.existsSync(mirrored)).toBe(false);
  });

  test('fails with FINAL_PROMPT_NOT_FOUND when output/final_prompt.md is missing', async () => {
    const { runDir, vibecodePath, finalPromptPath } = makeRun(tmpRoot, 'r5', null);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer, vibecodePath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FINAL_PROMPT_NOT_FOUND');
    expect(result.error.path).toBe(finalPromptPath);
    expect(Array.isArray(result.error.details)).toBe(true);

    expect(fs.existsSync(path.join(runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(vibecodePath, 'current', 'send_metadata.json'))).toBe(false);
    expect(writer.writes).toEqual([]);
  });

  test('records honest sent_payload_sha256 when appendNewline appends an extra newline', async () => {
    const content = 'hello';
    const { runDir } = makeRun(tmpRoot, 'r6', content);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer, appendNewline: '\r', enterDelayMs: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(writer.writes).toEqual([
      BRACKETED_PASTE_START + content + BRACKETED_PASTE_END,
      '\r',
    ]);

    const meta = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
    expect(meta.newline_appended).toBe(true);
    expect(meta.content_sha256).not.toBe(meta.sent_payload_sha256);
    expect(meta.sent_payload_sha256).toBe(sha256(BRACKETED_PASTE_START + content + BRACKETED_PASTE_END + '\r'));
    expect(meta.enter_sent_after_paste).toBe(true);
  });

  test('large multiline prompts are sent in multiple chunks and Enter is written only after the bracketed paste end marker', async () => {
    const lines = Array.from({ length: 80 }, (_value, index) => `line-${index.toString().padStart(3, '0')}: ${'x'.repeat(24)}`);
    const content = `${lines.join('\n')}\n`;
    const { runDir } = makeRun(tmpRoot, 'r6b', content);
    const writer = createWriter();

    const result = await sendFinalPrompt({
      runDir,
      writer,
      appendNewline: '\r',
      chunkSize: 64,
      chunkDelayMs: 0,
      enterDelayMs: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(writer.writes.length).toBeGreaterThan(2);
    expect(writer.writes.at(-1)).toBe('\r');

    const pasteWrites = writer.writes.slice(0, -1);
    expect(pasteWrites[0].startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(pasteWrites.at(-1)?.endsWith(BRACKETED_PASTE_END)).toBe(true);

    const reconstructedPaste = pasteWrites.join('');
    expect(reconstructedPaste.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(reconstructedPaste.endsWith(BRACKETED_PASTE_END)).toBe(true);
    expect(reconstructedPaste.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)).toBe(content);

    expect(result.metadata.chunk_count).toBe(pasteWrites.length);
    expect(result.metadata.lines).toBe(lines.length);
    expect(result.metadata.bracketed_paste).toBe(true);
    expect(result.metadata.enter_sent_after_paste).toBe(true);
  });

  test('planTerminalPromptSend makes first chunk start with bracketed paste start, last paste chunk end with bracketed paste end, and final action be Enter', () => {
    const content = `${Array.from({ length: 20 }, (_value, index) => `line ${index}`).join('\n')}\n`;
    const plan = planTerminalPromptSend(content, { chunkSize: 32, appendNewline: '\r' });

    expect(plan.pasteWrites.length).toBeGreaterThan(1);
    expect(plan.pasteWrites[0].startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(plan.pasteWrites.at(-1)?.endsWith(BRACKETED_PASTE_END)).toBe(true);
    expect(plan.enterWrite).toBe('\r');
    expect(plan.payload).toBe(BRACKETED_PASTE_START + content + BRACKETED_PASTE_END + '\r');
    expect(plan.pasteWrites.join('').slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)).toBe(content);
  });

  test('does not create any after/ artifacts and does not mutate final_prompt.md', async () => {
    const content = 'untouched\n';
    const { runDir, finalPromptPath } = makeRun(tmpRoot, 'r7', content);
    const writer = createWriter();

    const beforeBytes = fs.readFileSync(finalPromptPath);
    const result = await sendFinalPrompt({ runDir, writer });
    expect(result.ok).toBe(true);

    const afterDir = path.join(runDir, 'after');
    expect(fs.existsSync(afterDir)).toBe(false);

    const afterBytes = fs.readFileSync(finalPromptPath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  test('does not regenerate final_prompt or call prompt renderer (preview equals send source)', async () => {
    // Hand-crafted final_prompt.md content. If the send module secretly re-rendered,
    // the writer would receive the rendered output, which would differ from this fixture.
    const finalPromptContent = '# Custom Final Prompt\n\n(no renderer should overwrite this)\n';
    const { runDir } = makeRun(tmpRoot, 'r8', finalPromptContent);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer });
    expect(result.ok).toBe(true);

    expect(writer.writes[0]).toBe(BRACKETED_PASTE_START + finalPromptContent + BRACKETED_PASTE_END);
  });
});

describe('send_prompt source boundaries', () => {
  test('send_prompt.ts does not import prompt renderer or pipeline', () => {
    const sourcePath = path.resolve(__dirname, '../../../src/core/terminal/send_prompt.ts');
    const src = fs.readFileSync(sourcePath, 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*prompting\/(pipeline|renderer)/);
    expect(src).not.toMatch(/from\s+['"][^'"]*context\//);
    expect(src).not.toMatch(/from\s+['"][^'"]*skills\//);
    expect(src).not.toMatch(/from\s+['"][^'"]*scanning\//);
    expect(src).not.toMatch(/from\s+['"][^'"]*adapters\/llm/);
  });
});
