import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const indexHtml = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'index.html');

function readHtml(): string {
  return fs.readFileSync(indexHtml, 'utf8');
}

describe('desktop renderer CodeGraph toggle switch', () => {
  test('renders a CodeGraph toggle button using the shared toggle switch pattern', () => {
    const html = readHtml();

    expect(html).toMatch(/<button id="codegraph-toggle" class="toggle" type="button" role="switch" aria-checked="false"/);
    expect(html).toContain('<span class="sw"></span>');
    expect(html).toContain('CodeGraph');
  });

  test('does not render the old CodeGraph mode select dropdown', () => {
    const html = readHtml();

    expect(html).not.toContain('id="composer-cg-mode"');
    expect(html).not.toMatch(/<select[^>]+composer-cg-mode/);
  });

  test('uses the same toggle CSS class pattern for auto-approve and CodeGraph', () => {
    const html = readHtml();

    expect(html).toMatch(/<button id="auto-approve" class="toggle" type="button" role="switch" aria-checked="false"/);
    expect(html).toMatch(/<button id="codegraph-toggle" class="toggle" type="button" role="switch" aria-checked="false"/);
  });

  test('persists the CodeGraph toggle state in localStorage', () => {
    const html = readHtml();

    expect(html).toContain("localStorage.getItem('vibecode.codegraph.on')");
    expect(html).toContain("localStorage.setItem('vibecode.codegraph.on', on ? '1' : '0')");
  });
});
