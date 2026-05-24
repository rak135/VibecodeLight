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
});
