import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const rendererDir = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');
const indexHtml = path.join(rendererDir, 'index.html');
const stylesCss = path.join(rendererDir, 'styles.css');

function readHtml(): string {
  return fs.readFileSync(indexHtml, 'utf8');
}

describe('desktop renderer Elegant Dark shell', () => {
  test('ships a renderer styles.css referenced by index.html', () => {
    expect(fs.existsSync(stylesCss)).toBe(true);
    expect(readHtml()).toMatch(/styles\.css/);
  });

  test('defines the Elegant Dark theme tokens and terminal-first shell', () => {
    const css = fs.readFileSync(stylesCss, 'utf8');
    expect(css).toMatch(/--bg:\s*#0a0a0b/);
    expect(css).toMatch(/--accent:/);
    expect(css).toMatch(/\.app\b/);
    expect(css).toMatch(/\.tile\b/);
  });

  test('renders the minimal left sidebar global navigation', () => {
    const html = readHtml();
    expect(html).toMatch(/class="left/);
    expect(html).toMatch(/class="nav-item/);
    expect(html).toMatch(/id="toggle-sidebar"/);
  });

  test('renders the multi-terminal grid workspace with a density control', () => {
    const html = readHtml();
    expect(html).toMatch(/id="terminal-grid"/);
    expect(html).toMatch(/class="grid /);
    expect(html).toMatch(/id="density-seg"/);
    // Tiles are created at runtime by the multi-terminal controller.
    expect(html).toMatch(/terminals\.js/);
    expect(html).toMatch(/VibecodeTerminals/);
  });

  test('renders the right rail contextual inspector', () => {
    const html = readHtml();
    expect(html).toMatch(/class="right-rail"/);
    expect(html).toMatch(/class="right-panel/);
  });

  test('renders a translucent prompt overlay that is re-parented into the focused tile', () => {
    const html = readHtml();
    // The composer overlay element exists in the static markup; the
    // controller reparents it into whichever tile opens the composer.
    expect(html).toMatch(/class="overlay-layer"/);
    expect(html).toMatch(/id="composer-overlay"/);
    // CSS still scopes overlay visibility to the tile that owns it.
    const css = fs.readFileSync(stylesCss, 'utf8');
    expect(css).toMatch(/\.tile\.overlay-on \.overlay-layer/);
  });

  test('keeps the real composer wiring (task, build, send, terminal)', () => {
    const html = readHtml();
    const terminalsJs = fs.readFileSync(path.join(rendererDir, 'terminals.js'), 'utf8');
    expect(html).toMatch(/id="composer-task"/);
    expect(html).toMatch(/id="generate-preview"/);
    expect(html).toMatch(/id="send-to-terminal"/);
    // The xterm surface is now created per-tile by the multi-terminal
    // controller; tiles host it under a dedicated `tile-term` class.
    expect(terminalsJs).toMatch(/tile-term/);
  });

  test('wires per-tile Close terminal buttons to the real close path', () => {
    const terminalsJs = fs.readFileSync(path.join(rendererDir, 'terminals.js'), 'utf8');
    // The close button is per-tile, owned by the multi-terminal controller,
    // and routes through the real preload terminal close path with sessionId.
    expect(terminalsJs).toMatch(/tile-close/);
    expect(terminalsJs).toMatch(/api\.close\(\s*sessionId\s*\)/);
  });

  test('wires the Runs browser to the real run-display bridge', () => {
    const html = readHtml();
    // Runs nav and the run rail panel are now truly backed; no design-only marker.
    expect(html).not.toMatch(/class="[^"]*design-only[^"]*"\s+data-nav="runs"/);
    expect(html).not.toMatch(/class="[^"]*design-only[^"]*"\s+data-panel="run"/);
    // Wired to the real preload runs bridge (no renderer-side run discovery logic).
    expect(html).toMatch(/vibecodeAPI\.runs\.list\(\)/);
    expect(html).toMatch(/vibecodeAPI\.runs\.show\(/);
  });

  test('wires the Context panel to real run artifacts (no token-budget placeholder)', () => {
    const html = readHtml();
    // The context rail panel is now truly backed; no design-only marker.
    expect(html).not.toMatch(/class="[^"]*design-only[^"]*"\s+data-panel="context"/);
    // Renders from the real preview context summary, not placeholders.
    expect(html).toMatch(/function renderContextPanel/);
    expect(html).toMatch(/run\.context/);
    // The fake token-budget row is gone (no backend exists for it).
    expect(html).not.toMatch(/Token budget/);
  });

  test('derives the terminals count from the real multi-session controller', () => {
    const html = readHtml();
    // The helper reads the live count from the multi-terminal controller
    // instead of hard-coding 0/1.
    expect(html).toMatch(/function updateTerminalCount/);
    expect(html).toMatch(/terminals\.count\(\)/);
    expect(html).not.toMatch(/terminalReady\s*\?\s*'1'\s*:\s*'0'/);
  });

  test('marks design-only features with a quiet red-tint marker, not labels', () => {
    const html = readHtml();
    const css = fs.readFileSync(stylesCss, 'utf8');
    // Quiet developer marker exists as a CSS utility with a red-ish tint.
    expect(css).toMatch(/\.design-only\b/);
    expect(css).toMatch(/rgba\(\s*2[0-9][0-9]\s*,/); // a red channel near 255

    // add-terminal is now a real control and must not carry the marker.
    expect(html).not.toMatch(/id="add-terminal"[^>]*class="[^"]*design-only/);
    // auto-approve is still a UI-only toggle.
    expect(html).toMatch(/id="auto-approve"[^>]*class="[^"]*design-only/);

    // No status-disclaimer labels leak into the UI for design-only features.
    expect(html).not.toMatch(/not implemented/i);
    expect(html).not.toMatch(/coming soon/i);
    expect(html).not.toMatch(/not yet available/i);
  });

  test('wires the New terminal button through the multi-terminal controller', () => {
    const html = readHtml();
    expect(html).toMatch(/addTerminalBtn\.addEventListener/);
    expect(html).toMatch(/terminals\.addTerminal\(\)/);
  });

  test('has no light-theme switcher (Elegant Dark only)', () => {
    const html = readHtml();
    expect(html).not.toMatch(/theme-switch/);
  });
});
