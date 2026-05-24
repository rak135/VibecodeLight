import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const rendererDir = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');
const indexHtml = path.join(rendererDir, 'index.html');
const terminalKeysJs = path.join(rendererDir, 'terminal_keys.js');

describe('terminal copy renderer module stays a thin, secret-free view helper', () => {
  test('terminal_keys.js exists', () => {
    expect(fs.existsSync(terminalKeysJs)).toBe(true);
  });

  test('terminal_keys.js does not use Node fs or child_process', () => {
    const source = fs.readFileSync(terminalKeysJs, 'utf8');
    expect(source).not.toMatch(/\brequire\(\s*['"]fs['"]\s*\)/);
    expect(source).not.toMatch(/\brequire\(\s*['"]child_process['"]\s*\)/);
    expect(source).not.toMatch(/from\s+['"]fs['"]/);
    expect(source).not.toMatch(/from\s+['"]child_process['"]/);
  });
});

describe('renderer index.html wires selection-aware terminal copy', () => {
  test('loads the terminal_keys.js view module', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/terminal_keys\.js/);
    expect(html).toMatch(/VibecodeTerminalKeys/);
  });

  test('attaches the custom key handler to the real xterm terminal', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/attachCustomKeyEventHandler/);
    expect(html).toMatch(/createTerminalKeyHandler/);
  });

  test('routes the terminal copy through the existing Electron clipboard preload path', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/copyToClipboard/);
  });
});
