import fs from 'fs';
import os from 'os';
import path from 'path';

import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';

describe('full prompt pipeline integration', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-full-prompt-pipeline-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Fixture repo\n', 'utf8');
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'hello.ts'), 'export const hello = "world";\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('fixture repo full mock prompt run produces complete inspectable run', async () => {
    const result = await runPromptPipeline({
      task: 'fixture repo full mock prompt run',
      repoRoot: tmpRepo,
      mock: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedArtifacts = [
      'flash/flash_input.md',
      'flash/flash_output.md',
      'output/context_pack.md',
      'output/final_prompt.md',
    ];

    for (const relativePath of expectedArtifacts) {
      expect(fs.existsSync(path.join(result.runDir, relativePath))).toBe(true);
    }

    // Flash-derived legacy artifacts must not be produced.
    expect(fs.existsSync(path.join(result.runDir, 'skills', 'selected_skills.json'))).toBe(false);
    expect(fs.existsSync(path.join(result.runDir, 'skills', 'selected_skill_contents.md'))).toBe(false);

    const finalPrompt = fs.readFileSync(path.join(result.runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(finalPrompt).toContain('fixture repo full mock prompt run');
  });

  test('full mock prompt run does not create send_metadata.json', async () => {
    const result = await runPromptPipeline({ task: 'no send metadata integration', repoRoot: tmpRepo, mock: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.existsSync(path.join(result.runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRepo, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);
  });

  test('full mock prompt run does not require live credentials', async () => {
    const oldProvider = process.env.VIBECODE_PROVIDER;
    const oldApiKey = process.env.VIBECODE_API_KEY;
    const oldModel = process.env.VIBECODE_MODEL;
    const oldBaseUrl = process.env.VIBECODE_BASE_URL;

    delete process.env.VIBECODE_PROVIDER;
    delete process.env.VIBECODE_API_KEY;
    delete process.env.VIBECODE_MODEL;
    delete process.env.VIBECODE_BASE_URL;

    try {
      const result = await runPromptPipeline({ task: 'no live credentials integration', repoRoot: tmpRepo, mock: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fs.existsSync(result.finalPromptPath)).toBe(true);
    } finally {
      if (oldProvider === undefined) delete process.env.VIBECODE_PROVIDER;
      else process.env.VIBECODE_PROVIDER = oldProvider;
      if (oldApiKey === undefined) delete process.env.VIBECODE_API_KEY;
      else process.env.VIBECODE_API_KEY = oldApiKey;
      if (oldModel === undefined) delete process.env.VIBECODE_MODEL;
      else process.env.VIBECODE_MODEL = oldModel;
      if (oldBaseUrl === undefined) delete process.env.VIBECODE_BASE_URL;
      else process.env.VIBECODE_BASE_URL = oldBaseUrl;
    }
  });
});
