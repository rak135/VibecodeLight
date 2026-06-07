import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * Phase 5A: the desktop shell wires a read-only coordination observability panel
 * into the existing right rail. These assertions pin the wiring (rail entry,
 * panel module include, read-only data path) without asserting cosmetic layout.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const rendererDir = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');

function read(rel: string): string {
  return fs.readFileSync(path.join(rendererDir, rel), 'utf8');
}

describe('desktop renderer coordination panel wiring', () => {
  test('adds a coordination entry to the right rail', () => {
    const html = read('index.html');
    expect(html).toMatch(/data-panel="coordination"/);
  });

  test('includes the read-only coordination panel module and renders through it', () => {
    const html = read('index.html');
    expect(html).toMatch(/coordination_panel\.js/);
    expect(html).toMatch(/VibecodeCoordinationPanel/);
    expect(html).toMatch(/renderCoordinationOverviewHtml/);
  });

  test('renders the coordination panel from the read-only overview bridge', () => {
    const html = read('index.html');
    expect(html).toMatch(/coordination\.getOverview/);
    expect(html).toMatch(/renderCoordinationPanel/);
  });

  test('ships the coordination panel module with its pure renderer export', () => {
    const js = read('coordination_panel.js');
    expect(js).toMatch(/renderCoordinationOverviewHtml/);
    expect(js).toMatch(/window\.VibecodeCoordinationPanel/);
    expect(fs.existsSync(path.join(rendererDir, 'coordination_panel.d.ts'))).toBe(true);
  });
});
