/**
 * Tests for terminal_excerpt_after.md behavior:
 * - written after successful send
 * - not written after failed send
 * - bounded (lines/chars)
 * - ANSI-clean
 * - Unicode preserved
 * - PTY noise filtered
 * - send_metadata.json still written as before
 */

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

function createWriter(overrides: Partial<FakeWriter & { write(): void }> = {}): FakeWriter {
  const writes: string[] = [];
  return {
    sessionId: overrides.sessionId ?? 'desktop-test-001',
    cwd: overrides.cwd,
    writes,
    write(data: string) {
      writes.push(data);
      if (overrides.write) overrides.write.call(this);
    },
  };
}

function makeRun(
  tmpRoot: string,
  runId: string,
  finalPromptContent: string | null,
): { runDir: string; vibecodePath: string } {
  const vibecodePath = path.join(tmpRoot, '.vibecode');
  const runDir = path.join(vibecodePath, 'runs', runId);
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  if (finalPromptContent !== null) {
    fs.writeFileSync(path.join(runDir, 'output', 'final_prompt.md'), finalPromptContent, 'utf8');
  }
  return { runDir, vibecodePath };
}

describe('terminal_excerpt_after.md', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-excerpt-after-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('writes terminal/terminal_excerpt_after.md after successful send', async () => {
    const { runDir } = makeRun(tmpRoot, 'r1', '# Task\n\nDo thing.\n');
    const writer = createWriter();
    const terminalOutput = 'some output\nfrom the terminal\n';

    const result = await sendFinalPrompt({
      runDir,
      writer,
      terminalExcerpt: terminalOutput,
    });

    expect(result.ok).toBe(true);
    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(true);
  });

  test('does not write terminal_excerpt_after.md when send fails (writer throws)', async () => {
    const { runDir, vibecodePath } = makeRun(tmpRoot, 'r2', 'payload');
    const throwingWriter = createWriter({
      write() {
        throw new Error('write failed');
      },
    });

    const result = await sendFinalPrompt({
      runDir,
      writer: throwingWriter,
      vibecodePath,
      terminalExcerpt: 'output after failure',
    });

    expect(result.ok).toBe(false);
    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(false);
  });

  test('does not write terminal_excerpt_after.md when no terminalExcerpt provided', async () => {
    const { runDir } = makeRun(tmpRoot, 'r3', '# Task\n');
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer });

    expect(result.ok).toBe(true);
    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    // May or may not exist; if no excerpt provided, should not write a file
    // (empty/absent excerpt => no file)
    expect(fs.existsSync(excerptPath)).toBe(false);
  });

  test('terminal_excerpt_after.md is bounded by maxLines', async () => {
    const { runDir } = makeRun(tmpRoot, 'r4', '# Task\n');
    const writer = createWriter();
    // Generate many lines
    const manyLines = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');

    await sendFinalPrompt({ runDir, writer, terminalExcerpt: manyLines });

    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(true);
    const content = fs.readFileSync(excerptPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(500);
  });

  test('terminal_excerpt_after.md has no ANSI escape sequences', async () => {
    const { runDir } = makeRun(tmpRoot, 'r5', '# Task\n');
    const writer = createWriter();
    const ansiOutput = '\x1b[32mGreen text\x1b[0m and \x1b[1mbold\x1b[0m';

    await sendFinalPrompt({ runDir, writer, terminalExcerpt: ansiOutput });

    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    expect(fs.existsSync(excerptPath)).toBe(true);
    const content = fs.readFileSync(excerptPath, 'utf8');
    // eslint-disable-next-line no-control-regex
    expect(content).not.toMatch(/\x1b\[/);
  });

  test('terminal_excerpt_after.md preserves Unicode', async () => {
    const { runDir } = makeRun(tmpRoot, 'r6', '# Task\n');
    const writer = createWriter();
    const unicodeOutput = 'Héllo wörld 你好世界 🎉\n';

    await sendFinalPrompt({ runDir, writer, terminalExcerpt: unicodeOutput });

    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    const content = fs.readFileSync(excerptPath, 'utf8');
    expect(content).toContain('Héllo wörld');
    expect(content).toContain('你好世界');
    expect(content).toContain('🎉');
  });

  test('terminal_excerpt_after.md does not contain known PTY noise (AttachConsole)', async () => {
    const { runDir } = makeRun(tmpRoot, 'r7', '# Task\n');
    const writer = createWriter();
    // Use the exact noise pattern that filterKnownPtyNoise matches: "AttachConsole failed"
    const noisyOutput = 'AttachConsole failed\r\nActual output line\nAnother good line\n';

    await sendFinalPrompt({ runDir, writer, terminalExcerpt: noisyOutput });

    const excerptPath = path.join(runDir, 'terminal', 'terminal_excerpt_after.md');
    const content = fs.readFileSync(excerptPath, 'utf8');
    expect(content).not.toContain('AttachConsole');
    expect(content).toContain('Actual output line');
  });

  test('send_metadata.json still written correctly after successful send with excerpt', async () => {
    const payload = 'test prompt content';
    const { runDir } = makeRun(tmpRoot, 'r8', payload);
    const writer = createWriter({ sessionId: 'desktop-99-abc', cwd: '/tmp/repo' });

    const result = await sendFinalPrompt({
      runDir,
      writer,
      terminalExcerpt: 'terminal output here',
    });

    expect(result.ok).toBe(true);
    const metadataPath = path.join(runDir, 'terminal', 'send_metadata.json');
    expect(fs.existsSync(metadataPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(meta.run_id).toBe('r8');
    expect(meta.terminal_session_id).toBe('desktop-99-abc');
    expect(meta.sent_file).toBe('output/final_prompt.md');
  });

  test('no after/ artifacts are created by send', async () => {
    const { runDir } = makeRun(tmpRoot, 'r9', '# Task\n');
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer, terminalExcerpt: 'output' });
    expect(result.ok).toBe(true);

    const afterDir = path.join(runDir, 'after');
    expect(fs.existsSync(afterDir)).toBe(false);
  });

  test('returns excerptPath in success result when excerpt is written', async () => {
    const { runDir } = makeRun(tmpRoot, 'r10', '# Task\n');
    const writer = createWriter();

    const result = await sendFinalPrompt({ runDir, writer, terminalExcerpt: 'some output\n' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.excerptPath).toBe(path.join(runDir, 'terminal', 'terminal_excerpt_after.md'));
  });
});
