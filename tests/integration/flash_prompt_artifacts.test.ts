import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';

function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-prompt-artifacts-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  return repoRoot;
}

describe('flash prompt artifacts', () => {
  test('after pipeline run (mock mode), flash_system_prompt.md and flash_prompt_meta.json exist in flash dir with correct source/sha256/bytes', async () => {
    const repoRoot = makeRepo();
    const bundledPromptPath = path.resolve(__dirname, '../../resources/prompts/flash_system.md');

    try {
      const result = await runPromptPipeline({ task: 'flash prompt artifact test', repoRoot, mock: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const promptPath = path.join(result.runDir, 'flash', 'flash_system_prompt.md');
      const metaPath = path.join(result.runDir, 'flash', 'flash_prompt_meta.json');
      const bundledContent = fs.readFileSync(bundledPromptPath, 'utf8');
      const writtenPrompt = fs.readFileSync(promptPath, 'utf8');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
        source: string;
        resolvedPath?: string;
        sha256: string;
        bytes: number;
        warnings: string[];
      };

      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.existsSync(metaPath)).toBe(true);
      expect(writtenPrompt).toBe(bundledContent);
      expect(meta).toEqual({
        source: 'bundled-default',
        resolvedPath: bundledPromptPath,
        sha256: sha256Of(bundledContent),
        bytes: Buffer.byteLength(bundledContent, 'utf8'),
        warnings: [],
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
