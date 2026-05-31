import fs from 'fs';
import path from 'path';

describe('desktop renderer pipeline progress UI', () => {
  const indexHtmlPath = path.resolve(__dirname, '../../../src/app/desktop/renderer/index.html');
  const stylesCssPath = path.resolve(__dirname, '../../../src/app/desktop/renderer/styles.css');
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');

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

  // Pipeline Progress is a first-class artifact view, not a loading-only panel.
  // The progress section must be present in the static markup AND must not be
  // hidden with display:none — the step controller owns its visibility, and the
  // step must remain visible after the run completes, warns, or fails.
  test('pipeline progress section is rendered as 01 PIPELINE PROGRESS, not a transient sub-step', () => {
    expect(html).toMatch(/<div class="ov-section ov-step-panel active"[^>]*id="ov-progress-section"[^>]*data-step="pipeline-progress"/);
    expect(html).toMatch(/data-step-target="pipeline-progress"[\s\S]*?<span class="num">01<\/span>\s*pipeline progress/);
    // No inline display:none on the section header itself.
    expect(html).not.toMatch(/id="ov-progress-section"[^>]*style="display:none"/);
  });

  test('context flash section is rendered as a stable 02 step that exists from the start', () => {
    expect(html).toMatch(/<div class="ov-section ov-step-panel disabled"[^>]*id="ov-summary-section"[^>]*data-step="context-flash"/);
    expect(html).toMatch(/data-step-target="context-flash"[\s\S]*?<span class="num">02<\/span>\s*context flash/);
    expect(html).not.toMatch(/id="ov-summary-section"[^>]*style="display:none"/);
  });

  test('renderer loads the composer_steps controller before the inline script', () => {
    expect(html).toMatch(/<script src="composer_steps\.js"><\/script>/);
    expect(html).toMatch(/window\.VibecodeComposerSteps/);
    expect(html).toMatch(/composerSteps\.startRun\(\)/);
    expect(html).toMatch(/composerSteps\.markCompleted\(\)/);
    expect(html).toMatch(/composerSteps\.markFailed\(\)/);
  });

  test('renderer no longer hides the progress section on completion (the bug)', () => {
    // The old code toggled progress visibility by run stage, which destroyed
    // Pipeline Progress after the run finished. The fix removes that toggle.
    expect(html).not.toMatch(/progressSection\.style\.display\s*=\s*stage\s*===\s*'building'/);
  });

  test('CSS hides only inactive step content panels, keeping their labels visible', () => {
    expect(css).toMatch(/\.ov-step-panel:not\(\.active\)\s*\.ov-step-content\s*{\s*display:\s*none/);
    expect(css).toMatch(/\.ov-step-panel\.active\s+\.ov-step-button/);
    expect(css).toMatch(/\.ov-step-panel\.disabled\s+\.ov-step-button/);
  });

  test('step labels are keyboard-accessible buttons', () => {
    expect(html).toMatch(/class="ov-label ov-step-button"\s+role="button"\s+tabindex="0"/);
  });
});
