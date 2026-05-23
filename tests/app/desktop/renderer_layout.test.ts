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
    expect(html).toMatch(/class="tile/);
    expect(html).toMatch(/id="density-seg"/);
  });

  test('renders the right rail contextual inspector', () => {
    const html = readHtml();
    expect(html).toMatch(/class="right-rail"/);
    expect(html).toMatch(/class="right-panel/);
  });

  test('renders a per-terminal translucent prompt overlay', () => {
    const html = readHtml();
    expect(html).toMatch(/class="overlay-layer"/);
    // The overlay must live inside a terminal tile, not be a full-app modal.
    const tileIdx = html.indexOf('class="tile');
    const overlayIdx = html.indexOf('class="overlay-layer"');
    expect(tileIdx).toBeGreaterThanOrEqual(0);
    expect(overlayIdx).toBeGreaterThan(tileIdx);
  });

  test('keeps the real composer wiring (task, build, send, terminal)', () => {
    const html = readHtml();
    expect(html).toMatch(/id="composer-task"/);
    expect(html).toMatch(/id="generate-preview"/);
    expect(html).toMatch(/id="send-to-terminal"/);
    expect(html).toMatch(/id="terminal"/);
  });

  test('marks design-only features with a quiet red-tint marker, not labels', () => {
    const html = readHtml();
    const css = fs.readFileSync(stylesCss, 'utf8');
    // Quiet developer marker exists as a CSS utility with a red-ish tint.
    expect(css).toMatch(/\.design-only\b/);
    expect(css).toMatch(/rgba\(\s*2[0-9][0-9]\s*,/); // a red channel near 255

    // Unimplemented controls carry the marker class but stay clickable buttons.
    expect(html).toMatch(/id="add-terminal"[^>]*class="[^"]*design-only/);
    expect(html).toMatch(/id="auto-approve"[^>]*class="[^"]*design-only/);

    // No status-disclaimer labels leak into the UI for design-only features.
    expect(html).not.toMatch(/not implemented/i);
    expect(html).not.toMatch(/coming soon/i);
    expect(html).not.toMatch(/not yet available/i);
  });

  test('has no light-theme switcher (Elegant Dark only)', () => {
    const html = readHtml();
    expect(html).not.toMatch(/theme-switch/);
  });
});
