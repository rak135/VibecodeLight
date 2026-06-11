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

  test('SVG container uses absolute positioning to fill parent (viewport clip fix)', () => {
    const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
    // The SVG container must use absolute positioning to get explicit dimensions
    // from its parent, preventing the height="100%" circular dependency bug.
    const svgContainerMatch = css.match(/\.codebase-map-svg\s*\{[^}]*\}/);
    expect(svgContainerMatch).toBeTruthy();
    const svgContainerCss = svgContainerMatch![0];
    expect(svgContainerCss).toMatch(/position:\s*absolute/);
    expect(svgContainerCss).toMatch(/inset:\s*0/);
    // Must NOT have min-height (was the root cause of the clip bug)
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
