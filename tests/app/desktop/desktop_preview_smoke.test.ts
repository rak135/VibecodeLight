import fs from 'fs';
import os from 'os';
import path from 'path';

import { runSmoke } from '../../../src/app/desktop/desktop_preview_smoke.js';

describe('desktop preview smoke command', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-desktop-preview-smoke-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# desktop preview smoke fixture\n', 'utf8');
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('exports runSmoke and runs the preview pipeline successfully', async () => {
    expect(typeof runSmoke).toBe('function');

    await expect(runSmoke(tmpRepo)).resolves.toBeUndefined();

    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runIds = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((entry) => entry !== 'current') : [];
    expect(runIds.length).toBeGreaterThan(0);

    const runDir = path.join(runsDir, runIds[0]);
    const finalPromptPath = path.join(runDir, 'output', 'final_prompt.md');
    expect(fs.existsSync(finalPromptPath)).toBe(true);
    expect(fs.readFileSync(finalPromptPath, 'utf8').length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'index', 'repo_atlas.generated.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'repo_atlas.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'task_slice.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'relevance_selection.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input_budget.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'after'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);
  });
});
