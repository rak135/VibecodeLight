import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

describe('prompt pipeline phase boundary characterization', () => {
  test('successful full mock pipeline marks final manifest done and mirrors current artifacts', async () => {
    const repoRoot = makeRepo('vibecode-pipeline-phase-boundary-');
    try {
      const result = await runPromptPipeline({
        task: 'phase boundary characterization',
        repoRoot,
        mock: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runManifestPath = path.join(result.runDir, 'run_manifest.json');
      const currentDir = path.join(repoRoot, '.vibecode', 'current');
      const currentManifestPath = path.join(currentDir, 'run_manifest.json');

      const runManifest = readJson<{ status?: string }>(runManifestPath);
      const currentManifest = readJson<unknown>(currentManifestPath);

      expect(runManifest.status).toBe('done');
      expect(currentManifest).toEqual(runManifest);

      for (const relativePath of [
        'run_manifest.json',
        'context_pack.md',
        'selected_skills.json',
        'final_prompt.md',
      ]) {
        expect(fs.existsSync(path.join(currentDir, relativePath))).toBe(true);
      }

      for (const relativePath of [
        'output/final_prompt.md',
        'output/context_pack.md',
        'skills/selected_skills.json',
      ]) {
        expect(fs.existsSync(path.join(result.runDir, relativePath))).toBe(true);
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
