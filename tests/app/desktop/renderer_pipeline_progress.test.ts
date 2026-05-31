import fs from 'fs';
import path from 'path';

describe('desktop renderer pipeline progress UI', () => {
  const indexHtmlPath = path.resolve(__dirname, '../../../src/app/desktop/renderer/index.html');
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  test('progress section title says pipeline progress, not flash progress', () => {
    expect(html).toContain('pipeline progress');
    expect(html.toLowerCase()).not.toContain('flash progress');
  });

  test('renderer hides back-compat synonym phases from the progress list', () => {
    expect(html).toContain("'flash_stream_delta'");
    expect(html).toContain("'flash_response_received'");
    expect(html).toContain("'flash_output_validated'");
    expect(html).toContain("'final_prompt_written'");
  });

  test('renderer maps status values to glyphs (started, completed, skipped, warning, failed)', () => {
    expect(html).toMatch(/case 'started'/);
    expect(html).toMatch(/case 'skipped'/);
    expect(html).toMatch(/case 'warning'/);
    expect(html).toMatch(/case 'failed'/);
    expect(html).toMatch(/case 'completed'/);
  });

  test('renderer uses event.label and event.detail when present', () => {
    expect(html).toContain('event.label');
    expect(html).toContain('event.detail');
  });
});
