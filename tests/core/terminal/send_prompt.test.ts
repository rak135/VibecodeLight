import fs from 'fs';
import os from 'os';
import path from 'path';

import { sendFinalPrompt } from '../../../src/core/terminal/send_prompt.js';

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

  test('reads output/final_prompt.md from the run folder and writes exact content to the writer', async () => {
    const content = '# Task\n\nDo the thing.\n';
    const { runDir, finalPromptPath } = makeRun(tmpRoot, 'r1', content);
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(writer.writes).toEqual([content]);

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

    const result = await sendFinalPrompt({ runDir, writer, appendNewline: '\r' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(writer.writes).toEqual([content + '\r']);

    const meta = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
    expect(meta.newline_appended).toBe(true);
    expect(meta.content_sha256).not.toBe(meta.sent_payload_sha256);
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

    expect(writer.writes[0]).toBe(finalPromptContent);
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
