import { OutputExcerpt } from '../../../src/core/terminal/transcript.js';

describe('OutputExcerpt clean excerpt policy', () => {
  test('getCleanText strips ANSI codes', () => {
    const excerpt = new OutputExcerpt();
    excerpt.append('\x1b[32mGREEN\x1b[0m output');
    expect(excerpt.getCleanText()).toBe('GREEN output');
    expect(excerpt.getCleanText()).not.toMatch(/\x1b/);
  });

  test('getCleanText preserves Unicode', () => {
    const excerpt = new OutputExcerpt();
    excerpt.append('résumé 🦄 café');
    expect(excerpt.getCleanText()).toContain('résumé 🦄 café');
  });

  test('getCleanText is bounded same as getText', () => {
    const excerpt = new OutputExcerpt({ maxLines: 3 });
    excerpt.append('a\nb\nc\nd\ne');
    const lines = excerpt.getCleanText().split('\n');
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  test('getCleanText does not include ANSI escape sequences', () => {
    const excerpt = new OutputExcerpt();
    excerpt.append('\x1b[31mred\x1b[0m\n\x1b[32mgreen\x1b[0m');
    const clean = excerpt.getCleanText();
    // No ESC character should remain
    expect(clean).not.toMatch(/\x1b/);
    // But the words should still be there
    expect(clean).toContain('red');
    expect(clean).toContain('green');
  });

  test('getCleanText filters known AttachConsole failed PTY noise', () => {
    const excerpt = new OutputExcerpt();
    excerpt.append('Error: AttachConsole failed\nVIBECODE_PTY_OK\n');
    const clean = excerpt.getCleanText();
    expect(clean).not.toContain('AttachConsole failed');
    expect(clean).toContain('VIBECODE_PTY_OK');
  });

  test('getCleanText does not filter normal stderr-like user output', () => {
    const excerpt = new OutputExcerpt();
    excerpt.append('error: build failed\nsome other line');
    const clean = excerpt.getCleanText();
    expect(clean).toContain('error: build failed');
    expect(clean).toContain('some other line');
  });

  test('getText still returns raw text (including ANSI) for internal use', () => {
    const excerpt = new OutputExcerpt();
    excerpt.append('\x1b[31mred\x1b[0m');
    // getRawText (or getText) still has raw content
    expect(excerpt.getText()).toContain('\x1b');
  });
});
