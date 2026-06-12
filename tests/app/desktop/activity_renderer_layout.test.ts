import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * The desktop shell wires a read-only activity observability panel into the
 * existing right rail. These assertions pin the wiring (rail entry, panel
 * module include, read-only data path, polling lifecycle) without asserting
 * cosmetic layout.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const rendererDir = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer');

function read(rel: string): string {
  return fs.readFileSync(path.join(rendererDir, rel), 'utf8');
}

describe('desktop renderer activity panel wiring', () => {
  test('adds an activity entry to the right rail', () => {
    const html = read('index.html');
    expect(html).toMatch(/data-panel="activity"/);
  });

  test('includes the read-only activity panel module and renders through it', () => {
    const html = read('index.html');
    expect(html).toMatch(/activity_panel\.js/);
    expect(html).toMatch(/VibecodeActivityPanel/);
    expect(html).toMatch(/renderActivityOverviewHtml/);
  });

  test('renders the activity panel from the read-only observability bridge', () => {
    const html = read('index.html');
    expect(html).toMatch(/observability\.getActivityOverview/);
    expect(html).toMatch(/renderActivityPanel/);
  });

  test('starts and stops activity polling with the panel (no leaked timers)', () => {
    const html = read('index.html');
    expect(html).toMatch(/startActivityPolling/);
    expect(html).toMatch(/stopActivityPolling/);
    // The stop path must clear the interval handle.
    expect(html).toMatch(/activityPollTimer\s*!=\s*null[\s\S]{0,120}clearInterval\(activityPollTimer\)/);
  });

  test('ships the activity panel module with its pure renderer export', () => {
    const js = read('activity_panel.js');
    expect(js).toMatch(/renderActivityOverviewHtml/);
    expect(js).toMatch(/window\.VibecodeActivityPanel/);
    expect(fs.existsSync(path.join(rendererDir, 'activity_panel.d.ts'))).toBe(true);
  });
});
