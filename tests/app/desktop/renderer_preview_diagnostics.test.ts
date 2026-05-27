import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const indexHtml = path.join(repoRoot, 'src', 'app', 'desktop', 'renderer', 'index.html');

describe('desktop renderer preview diagnostics', () => {
  test('summary/diagnostics render compact flash budget information and artifact paths', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');

    expect(html).toContain('estimated tokens');
    expect(html).toContain('budget status');
    expect(html).toContain('flash_input.md');
    expect(html).toContain('repo atlas');
    expect(html).toContain('task_slice.md');
    expect(html).toContain('flash_input_budget.json');
    expect(html).toContain('FLASH_INPUT_BUDGET_EXCEEDED');
  });

  test('composer surfaces optional CodeGraph status chip sourced from core (no renderer detection)', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');

    // A persistent chip in the composer header (visible before any build).
    expect(html).toContain('id="composer-cg-chip"');
    expect(html).toContain('id="composer-cg-dot"');
    expect(html).toContain('id="composer-cg-chip-text"');

    // Status comes from core-derived data: latest run on open (runs.list) and the
    // build result afterwards. The renderer must not run detection or fetch/parse
    // the external_tools.json artifact itself.
    expect(html).toContain('refreshComposerCodeGraphChip');
    expect(html).toContain('renderCodeGraphChip(result.codegraph)');
    expect(html).toContain('window.vibecodeAPI.runs.list()');
    expect(html).not.toContain('detectCodeGraph');
    expect(html).not.toMatch(/readRunArtifact[^;]*external_tools/);

    // The summary makes "used or not" explicit, including skipped/use-existing results.
    expect(html).toContain('codeGraphUsedSummaryValue');
    expect(html).toContain("['codegraph used', codeGraphUsedSummaryValue(result.codegraph)]");
    expect(html).toContain('codeGraphRepoAtlasSummaryValue');
    expect(html).toContain("['repo atlas', codeGraphRepoAtlasSummaryValue(result.codegraph)]");
    expect(html).toContain('id="composer-cg-mode"');
    expect(html).toContain('Use CodeGraph in context');
  });

  test('binds CodeGraph action buttons once so explicit clicks do not multiply across composer reopens', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');

    expect(html).toContain('let _cgButtonsBound = false;');
    expect(html).toContain('if (_cgButtonsBound) return;');
    expect(html).toContain('_cgButtonsBound = true;');
  });

  // CodeGraph context warnings (e.g. CODEGRAPH_INDEX_STALE) are pre-formatted in
  // core and surfaced in the GUI under the existing "codegraph used" row. The
  // row appears only when warnings are present and never shows as a fatal error.
  test('composer summary renders CodeGraph warnings under the used row when present', () => {
    const html = fs.readFileSync(indexHtml, 'utf8');

    // A dedicated helper computes the compact warning row value.
    expect(html).toContain('function codeGraphWarningSummaryValue');
    // It pulls the pre-formatted text from core (displayWarnings).
    expect(html).toContain('cg.displayWarnings');
    // The summary grid pushes the warning row conditionally — never injecting
    // an empty/missing row when nothing is wrong.
    expect(html).toContain("rows.push(['codegraph warning', warningValue])");
    // The detail block under the status label also surfaces warnings.
    expect(html).toContain('cg-warning');
    // Renderer never reads codegraph_usage.json directly.
    expect(html).not.toMatch(/codegraph_usage\.json/);
  });
});
