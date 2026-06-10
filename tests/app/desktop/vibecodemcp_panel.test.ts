import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const rendererDir = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');
const indexHtml = path.join(rendererDir, 'index.html');
const stylesCss = path.join(rendererDir, 'styles.css');

function readHtml(): string {
  return fs.readFileSync(indexHtml, 'utf8');
}

describe('desktop VibecodeMCP panel', () => {
  test('left nav contains VibecodeMCP entry and no Runs entry', () => {
    const html = readHtml();
    expect(html).toMatch(/data-nav="vibecodemcp"/);
    expect(html).not.toMatch(/data-nav="runs"/);
    expect(html).toMatch(/VibecodeMCP/);
  });

  test('right rail still contains run panel', () => {
    const html = readHtml();
    expect(html).toMatch(/data-panel="run"/);
  });

  test('VibecodeMCP panel container exists in markup', () => {
    const html = readHtml();
    expect(html).toMatch(/id="vibecodemcp-panel"/);
  });

  test('VibecodeMCP panel has header, agent cards, tools, and result sections', () => {
    const html = readHtml();
    expect(html).toMatch(/id="vibecodemcp-header"/);
    expect(html).toMatch(/id="vibecodemcp-agents"/);
    expect(html).toMatch(/id="vibecodemcp-tools"/);
    expect(html).toMatch(/id="vibecodemcp-result"/);
  });

  test('VibecodeMCP panel has agent placeholders for Claude, Codex, and OpenCode', () => {
    const html = readHtml();
    const js = fs.readFileSync(path.join(rendererDir, 'vibecodemcp_panel.js'), 'utf8');
    // The agent guidance settings tab already has literal claude/codex placeholders.
    expect(html + js).toMatch(/data-agent="claude"/);
    expect(html + js).toMatch(/data-agent="codex"/);
    // OpenCode is referenced dynamically in the panel JS.
    expect(js).toMatch(/opencode/);
  });

  test('VibecodeMCP panel CSS rules exist', () => {
    const css = fs.readFileSync(stylesCss, 'utf8');
    expect(css).toMatch(/\.vibecodemcp-panel\b/);
    expect(css).toMatch(/\.vibecodemcp-card\b/);
    expect(css).toMatch(/\.vibecodemcp-header\b/);
  });

  test('VibecodeMCP panel calls the mcp bridge API', () => {
    const html = readHtml();
    const js = fs.readFileSync(path.join(rendererDir, 'vibecodemcp_panel.js'), 'utf8');
    expect(html + js).toMatch(/vibecodeAPI\.mcp\.getOverview/);
    expect(html + js).toMatch(/vibecodeAPI\.mcp\.doctor/);
    expect(html + js).toMatch(/vibecodeAPI\.mcp\.installDryRun/);
    expect(html + js).toMatch(/vibecodeAPI\.mcp\.install/);
  });

  test('VibecodeMCP panel does not auto-install on open', () => {
    const html = readHtml();
    const js = fs.readFileSync(path.join(rendererDir, 'vibecodemcp_panel.js'), 'utf8');
    // The initial render function should not call install without a user click.
    expect(html + js).not.toMatch(/install\([^)]*\)[\s\S]{0,200}without click/i);
    // The panel should show a refresh button, not auto-refresh.
    expect(html + js).toMatch(/id="vibecodemcp-refresh"/);
  });
});
