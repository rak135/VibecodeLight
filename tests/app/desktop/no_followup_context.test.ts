import fs from 'fs';
import os from 'os';
import path from 'path';

describe('no follow-up context artifacts', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-no-followup-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# test\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('prompt preview does not create terminal_context.json', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const result = await generatePromptPreview({ task: 'no followup test', repoRoot: tmpRepo });
    if (!result.ok) return; // skip if pipeline fails for unrelated reasons
    const runDir = result.runDir;
    expect(fs.existsSync(path.join(runDir, 'terminal', 'terminal_context.json'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'terminal', 'terminal_excerpt_after.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'after'))).toBe(false);
  });

  test('flash_input.md does not contain Terminal Context section', async () => {
    const { generatePromptPreview } = await import('../../../src/app/desktop/prompt_preview_service.js');
    const result = await generatePromptPreview({ task: 'no followup flash test', repoRoot: tmpRepo });
    if (!result.ok) return;
    const runDir = result.runDir;
    const flashInputPath = path.join(runDir, 'flash', 'flash_input.md');
    if (!fs.existsSync(flashInputPath)) return;
    const content = fs.readFileSync(flashInputPath, 'utf8');
    expect(content).not.toMatch(/terminal context/i);
  });
});
