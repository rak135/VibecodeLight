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

  test('defines theme custom properties and the terminal-first shell layout', () => {
    const css = fs.readFileSync(stylesCss, 'utf8');
    expect(css).toMatch(/--accent:/);
    expect(css).toMatch(/\.app\b/);
    expect(css).toMatch(/\.tile\b/);
  });

  test('renders the left sidebar with global navigation and a toggle control', () => {
    const html = readHtml();
    expect(html).toMatch(/id="toggle-sidebar"/);
    expect(html).toMatch(/nav-item/);
  });

  test('renders the multi-terminal grid workspace with a density control and terminal JS', () => {
    const html = readHtml();
    expect(html).toMatch(/id="terminal-grid"/);
    expect(html).toMatch(/id="density-seg"/);
    // Tiles are created at runtime by the multi-terminal controller.
    expect(html).toMatch(/terminals\.js/);
    expect(html).toMatch(/VibecodeTerminals/);
  });

  test('renders the right rail contextual inspector panel', () => {
    const html = readHtml();
    expect(html).toMatch(/right-rail/);
    expect(html).toMatch(/right-panel/);
  });

  test('renders a prompt composer overlay element', () => {
    const html = readHtml();
    // The composer overlay element exists in the static markup; the
    // controller reparents it into whichever tile opens the composer.
    expect(html).toMatch(/id="composer-overlay"/);
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

  test('marks design-only features with a quiet visual marker, not labels', () => {
    const html = readHtml();
    const css = fs.readFileSync(stylesCss, 'utf8');
    // A design-only CSS utility class exists for developer use.
    expect(css).toMatch(/\.design-only\b/);

    // add-terminal is now a real control and must not carry the marker.
    expect(html).not.toMatch(/id="add-terminal"[^>]*class="[^"]*design-only/);
    // auto-approve is now a real, wired control and must not carry the marker.
    expect(html).not.toMatch(/id="auto-approve"[^>]*class="[^"]*design-only/);

    // No status-disclaimer labels leak into the UI for design-only features.
    expect(html).not.toMatch(/coming soon/i);
    expect(html).not.toMatch(/not yet available/i);

    // The Settings → Terminal tab is allowed (and required) to state the
    // PTY-injection boundary explicitly so users know Vibecode does NOT push
    // hidden text into the terminal. That boundary statement is a safety
    // disclosure, not a design-only label. Any remaining "not implemented"
    // mention must be inside the Terminal tab safety block — nowhere else.
    const matches = html.match(/not implemented/gi) || [];
    expect(matches.length).toBeLessThanOrEqual(1);
    if (matches.length === 1) {
      const terminalPanel = html.match(/<div[^>]*data-tab-panel="terminal"[\s\S]*?<\/div>/);
      expect(terminalPanel).not.toBeNull();
      expect(terminalPanel![0]).toMatch(/not implemented/i);
      expect(terminalPanel![0]).toMatch(/PTY|terminal/i);
    }
  });

  test('wires auto-approve as a real toggle that auto-sends after a successful build', () => {
    const html = readHtml();
    // The toggle lives in the prompt/task action area, next to the Build context control.
    const taskActions = html.match(/<div class="ov-task-actions">[\s\S]*?<\/div>\s*<\/div>/);
    expect(taskActions).not.toBeNull();
    expect(taskActions![0]).toMatch(/id="auto-approve"/);
    // A helper reflects the toggle state and is consulted by the send path.
    expect(html).toMatch(/function autoApproveEnabled/);
    // The send call forwards the auto-approve flag through the composer bridge.
    expect(html).toMatch(/sendPreview\([^)]*autoApproveEnabled\(\)/);
    // A successful build triggers an automatic send when auto-approve is on.
    expect(html).toMatch(/autoApproveEnabled\(\)[\s\S]{0,80}sendToTerminal\(\)/);
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

  test('keeps the scroll chain intact so stacked tiles stay reachable', () => {
    const css = fs.readFileSync(stylesCss, 'utf8');

    // The app grid must pin its single content row to the viewport. Without an
    // explicit row, the implicit `auto` row grows to the tiles' max-content
    // height, pushing the column past 100vh so the workspace never scrolls.
    const appRule = css.match(/\.app\s*\{[^}]*\}/);
    expect(appRule).not.toBeNull();
    expect(appRule![0]).toMatch(/grid-template-rows:\s*100vh/);

    // The center column must be allowed to shrink to the pinned row; a grid item
    // defaults to min-height:auto (min-content), which would otherwise overflow
    // the viewport and starve the workspace scroll container.
    const centerRule = css.match(/\.center\s*\{[^}]*\}/);
    expect(centerRule).not.toBeNull();
    expect(centerRule![0]).toMatch(/min-height:\s*0/);

    // The workspace is the real scroll container and the grid grows past it.
    const workspaceRule = css.match(/\.workspace\s*\{[^}]*\}/);
    expect(workspaceRule).not.toBeNull();
    expect(workspaceRule![0]).toMatch(/overflow:\s*auto/);
    expect(workspaceRule![0]).toMatch(/min-height:\s*0/);

    const gridRule = css.match(/\.grid\s*\{[^}]*\}/);
    expect(gridRule).not.toBeNull();
    expect(gridRule![0]).toMatch(/min-height:\s*100%/);
  });

  test('loads addon-fit and wires FitAddonCtor into the terminal controller', () => {
    const html = readHtml();
    const js = fs.readFileSync(path.join(rendererDir, 'terminals.js'), 'utf8');

    // The addon script must be loaded before terminals.js so the global is available.
    expect(html).toMatch(/vendor\/xterm\/addon-fit\.js/);

    // FitAddonCtor must be passed into the controller so it can resize xterm to
    // fill the tile, eliminating the black gap that appears when few terminals
    // are open and tiles are taller than the default fixed-row canvas height.
    expect(html).toMatch(/FitAddonCtor/);
    expect(html).toMatch(/window\.FitAddon/);

    // terminals.js must use the addon (loadAddon), fit after open, and track
    // tile size changes with a ResizeObserver.
    expect(js).toMatch(/loadAddon/);
    expect(js).toMatch(/fitAddon\.fit\(\)/);
    expect(js).toMatch(/ResizeObserver/);
  });
});
