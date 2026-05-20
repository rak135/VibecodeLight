import fs from 'fs';
import os from 'os';
import path from 'path';

import { generatePromptPreview } from '../../src/app/desktop/prompt_preview_service.js';

describe('composer preview integration flow', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-composer-flow-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# composer flow fixture\n', 'utf8');
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('full mock composer run produces same artifacts as CLI prompt pipeline', async () => {
    const result = await generatePromptPreview({
      task: 'composer integration: full mock run produces same artifacts as CLI',
      repoRoot: tmpRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = [
      'flash/flash_input.md',
      'flash/flash_output.md',
      'output/context_pack.md',
      'skills/selected_skills.json',
      'skills/selected_skill_contents.md',
      'output/final_prompt.md',
    ];

    for (const rel of expected) {
      expect(fs.existsSync(path.join(result.runDir, rel))).toBe(true);
    }

    const savedFinal = fs.readFileSync(result.finalPromptPath, 'utf8');
    expect(result.finalPrompt).toEqual(savedFinal);
  });

  test('composer preview run does not create terminal/send_metadata.json or after/ artifacts', async () => {
    const result = await generatePromptPreview({
      task: 'composer integration: preview only, no send',
      repoRoot: tmpRepo,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fs.existsSync(path.join(result.runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(result.runDir, 'after'))).toBe(false);
  });
});
