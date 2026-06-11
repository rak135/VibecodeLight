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
    expect(html).toMatch(/id="codebase-map-fit"/);
    expect(html).toMatch(/id="codebase-map-reset"/);
  });

  test('Codebase Map legend DOM exists', () => {
    const html = readHtml();
    expect(html).toMatch(/id="cmap-legend"/);
    expect(html).toMatch(/id="cmap-legend-nodes"/);
    expect(html).toMatch(/id="cmap-legend-edges"/);
    expect(html).toMatch(/id="cmap-legend-status"/);
  });

  test('Codebase Map tooltip DOM exists', () => {
    const html = readHtml();
    expect(html).toMatch(/id="cmap-tooltip"/);
  });

  test('Codebase Map detail panel DOM exists', () => {
    const html = readHtml();
    expect(html).toMatch(/id="cmap-detail"/);
    expect(html).toMatch(/id="cmap-detail-title"/);
    expect(html).toMatch(/id="cmap-detail-body"/);
    expect(html).toMatch(/id="cmap-detail-close"/);
  });

  test('Codebase Map layout container exists', () => {
    const html = readHtml();
    expect(html).toMatch(/class="codebase-map-layout"/);
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
    expect(css).toMatch(/\.codebase-map-viewport/);
  });

  test('Codebase Map legend CSS exists', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.cmap-legend/);
    expect(css).toMatch(/\.cmap-legend-section/);
    expect(css).toMatch(/\.cmap-legend-title/);
    expect(css).toMatch(/\.cmap-legend-items/);
    expect(css).toMatch(/\.cmap-legend-item/);
    expect(css).toMatch(/\.cmap-legend-dot/);
    expect(css).toMatch(/\.cmap-legend-line/);
    expect(css).toMatch(/\.cmap-legend-badge/);
  });

  test('Codebase Map tooltip CSS exists', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.cmap-tooltip/);
    expect(css).toMatch(/\.tt-path/);
    expect(css).toMatch(/\.tt-row/);
    expect(css).toMatch(/\.tt-badge/);
  });

  test('Codebase Map detail panel CSS exists', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.cmap-detail/);
    expect(css).toMatch(/\.cmap-detail-head/);
    expect(css).toMatch(/\.cmap-detail-title/);
    expect(css).toMatch(/\.cmap-detail-close/);
    expect(css).toMatch(/\.cmap-detail-body/);
    expect(css).toMatch(/\.cmap-detail-section/);
    expect(css).toMatch(/\.cmap-detail-row/);
    expect(css).toMatch(/\.cmap-detail-list/);
    expect(css).toMatch(/\.cmap-detail-empty/);
  });

  test('Codebase Map layout CSS exists', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.codebase-map-layout/);
  });

  test('SVG container uses absolute positioning to fill parent (viewport clip fix)', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    const svgContainerMatch = css.match(/\.codebase-map-svg\s*\{[^}]*\}/);
    expect(svgContainerMatch).toBeTruthy();
    const svgContainerCss = svgContainerMatch![0];
    expect(svgContainerCss).toMatch(/position:\s*absolute/);
    expect(svgContainerCss).toMatch(/inset:\s*0/);
    expect(svgContainerCss).not.toMatch(/min-height/);
  });

  test('SVG element CSS sets explicit width/height', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    const svgElMatch = css.match(/\.codebase-map-svg\s+svg\s*\{[^}]*\}/);
    expect(svgElMatch).toBeTruthy();
    const svgElCss = svgElMatch![0];
    expect(svgElCss).toMatch(/width:\s*100%/);
    expect(svgElCss).toMatch(/height:\s*100%/);
  });

  test('sidebar click handler includes codebasemap case', () => {
    const html = readHtml();
    expect(html).toMatch(/nav === 'codebasemap'/);
    expect(html).toMatch(/CodebaseMapPanel\.open/);
    expect(html).toMatch(/CodebaseMapPanel\.close/);
  });
});
