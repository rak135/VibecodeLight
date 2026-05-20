import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const rendererHtml = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'index.html');

describe('desktop renderer assets', () => {
  test('renderer index.html does not load assets from unpkg.com CDN', () => {
    const html = fs.readFileSync(rendererHtml, 'utf8');
    expect(html).not.toMatch(/unpkg\.com/);
    expect(html).not.toMatch(/cdn\.jsdelivr\.net/);
  });

  test('renderer index.html references local xterm vendor assets', () => {
    const html = fs.readFileSync(rendererHtml, 'utf8');
    expect(html).toMatch(/vendor\/xterm\/xterm\.css/);
    expect(html).toMatch(/vendor\/xterm\/xterm\.js/);
  });

  test('renderer Content-Security-Policy restricts default-src to self', () => {
    const html = fs.readFileSync(rendererHtml, 'utf8');
    const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    const csp = cspMatch?.[1] ?? '';
    expect(csp).not.toMatch(/unpkg\.com/);
    expect(csp).toMatch(/default-src\s+'self'/);
  });

  test('@xterm/xterm package ships expected asset files in node_modules', () => {
    const xtermDir = path.join(repoRoot, 'node_modules', '@xterm', 'xterm');
    expect(fs.existsSync(path.join(xtermDir, 'lib', 'xterm.js'))).toBe(true);
    expect(fs.existsSync(path.join(xtermDir, 'css', 'xterm.css'))).toBe(true);
  });
});
