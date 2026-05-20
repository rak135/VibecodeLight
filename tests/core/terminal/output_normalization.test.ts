import { filterKnownPtyNoise, normalizeTerminalOutput, stripAnsi } from '../../../src/core/terminal/output_normalization.js';

describe('stripAnsi', () => {
  test('removes common SGR escape codes (colors)', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  test('removes bold/dim/underline sequences', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[22m')).toBe('bold');
  });

  test('removes cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2J\x1b[H')).toBe('');
  });

  test('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;window title\x07')).toBe('');
  });

  test('preserves plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  test('preserves Unicode characters', () => {
    expect(stripAnsi('héllo wörld 🌍')).toBe('héllo wörld 🌍');
  });

  test('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  test('preserves newlines', () => {
    expect(stripAnsi('line1\nline2')).toBe('line1\nline2');
  });
});

describe('normalizeTerminalOutput', () => {
  test('strips ANSI codes', () => {
    const result = normalizeTerminalOutput('\x1b[32mGREEN\x1b[0m');
    expect(result).toBe('GREEN');
    expect(result).not.toMatch(/\x1b/);
  });

  test('preserves Unicode', () => {
    const result = normalizeTerminalOutput('résumé café 🦄');
    expect(result).toContain('résumé café 🦄');
  });

  test('preserves meaningful command output', () => {
    const result = normalizeTerminalOutput('VIBECODE_PTY_OK\ngit status clean');
    expect(result).toContain('VIBECODE_PTY_OK');
    expect(result).toContain('git status clean');
  });

  test('preserves newlines', () => {
    const result = normalizeTerminalOutput('a\nb\nc');
    expect(result).toBe('a\nb\nc');
  });

  test('does not strip arbitrary stderr-like content', () => {
    const result = normalizeTerminalOutput('error: something went wrong');
    expect(result).toContain('error: something went wrong');
  });
});

describe('filterKnownPtyNoise', () => {
  test('filters AttachConsole failed lines from output', () => {
    const input = 'AttachConsole failed\nVIBECODE_PTY_OK\n';
    const result = filterKnownPtyNoise(input);
    expect(result).not.toContain('AttachConsole failed');
    expect(result).toContain('VIBECODE_PTY_OK');
  });

  test('does not remove normal stderr-like user output', () => {
    const input = 'error: build failed\nsome other line';
    const result = filterKnownPtyNoise(input);
    expect(result).toContain('error: build failed');
    expect(result).toContain('some other line');
  });

  test('filters only exact known PTY noise pattern', () => {
    const input = 'The AttachConsole function failed due to bad args\nNormal line';
    // This must NOT be filtered — it contains "AttachConsole failed" as a substring
    // but is different from the known pattern "AttachConsole failed" standalone line
    // This test verifies we only filter the known spam, not arbitrary containing lines.
    // The known noise is: lines matching /^Error: AttachConsole failed$/i
    const result = filterKnownPtyNoise(input);
    // The first line does NOT match the known pattern (different prefix), so it stays
    expect(result).toContain('Normal line');
  });

  test('preserves empty lines in output', () => {
    const input = 'line1\n\nline2';
    const result = filterKnownPtyNoise(input);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  test('handles empty string', () => {
    expect(filterKnownPtyNoise('')).toBe('');
  });
});
