import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const rendererDir = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');
const indexHtml = path.join(rendererDir, 'index.html');

function readHtml(): string {
  return fs.readFileSync(indexHtml, 'utf8');
}

describe('desktop renderer codebase map layout', () => {
  test('left sidebar has a Codebase Map nav item below VibecodeMCP', () => {
    const html = readHtml();
    expect(html).toMatch(/data-nav="codebasemap"/);
    expect(html).toMatch(/title="Codebase Map"/);
  });

  test('Codebase Map nav item appears after VibecodeMCP nav item', () => {
    const html = readHtml();
    const mcpIndex = html.indexOf('data-nav="vibecodemcp"');
    const mapIndex = html.indexOf('data-nav="codebasemap"');
    expect(mcpIndex).toBeGreaterThan(0);
    expect(mapIndex).toBeGreaterThan(mcpIndex);
  });

  test('Codebase Map panel DOM exists with expected elements', () => {
    const html = readHtml();
    expect(html).toMatch(/id="codebase-map-panel"/);
    expect(html).toMatch(/id="codebase-map-repo"/);
    expect(html).toMatch(/id="codebase-map-meta"/);
    expect(html).toMatch(/id="codebase-map-svg"/);
    expect(html).toMatch(/id="codebase-map-empty"/);
    expect(html).toMatch(/id="codebase-map-refresh"/);
    expect(html).toMatch(/id="codebase-map-close"/);
    expect(html).toMatch(/id="codebase-map-filters"/);
    expect(html).toMatch(/id="codebase-map-search"/);
    expect(html).toMatch(/id="codebase-map-edges-toggle"/);
  });

  test('Codebase Map panel script is loaded', () => {
    const html = readHtml();
    expect(html).toMatch(/codebase_map_panel\.js/);
  });

  test('Codebase Map panel CSS exists in styles.css', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.codebase-map-panel/);
    expect(css).toMatch(/\.codebase-map-header/);
    expect(css).toMatch(/\.codebase-map-body/);
    expect(css).toMatch(/\.cmap-chip/);
    expect(css).toMatch(/\.codebase-map-search/);
    expect(css).toMatch(/\.codebase-map-empty/);
  });

  test('sidebar click handler includes codebasemap case', () => {
    const html = readHtml();
    expect(html).toMatch(/nav === 'codebasemap'/);
    expect(html).toMatch(/CodebaseMapPanel\.open/);
    expect(html).toMatch(/CodebaseMapPanel\.close/);
  });
});
