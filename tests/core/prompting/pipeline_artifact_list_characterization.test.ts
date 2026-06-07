import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';

/**
 * TEMPORARY: Pins exact pipeline artifact list including generated paths
 * outside the run directory. Should be replaced by pipeline.test.ts with
 * arrayContaining shape assertions when the artifact contract is frozen.
 * Remove when pipeline.test.ts covers the same artifact set with stable
 * shape tests. Do not add new assertions here.
 */

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

function toRelativeArtifacts(runDir: string, artifacts: string[]): string[] {
  return artifacts.map((artifact) => path.relative(runDir, artifact).replace(/\\/g, '/'));
}

describe('prompt pipeline artifact list characterization', () => {
  test('successful full mock pipeline returns the current artifact contract', async () => {
    const repoRoot = makeRepo('vibecode-pipeline-artifact-list-');
    try {
      const result = await runPromptPipeline({
        task: 'artifact list characterization',
        repoRoot,
        mock: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const relativeArtifacts = toRelativeArtifacts(result.runDir, result.artifacts);
      expect(relativeArtifacts).toEqual(expect.arrayContaining([
        'config_resolution.json',
        'task_intent.json',
        'task_intent.md',
        'flash/flash_system_prompt.md',
        'flash/flash_prompt_meta.json',
        // Current behavior: result.artifacts reports the shared generated atlas
        // path outside the run directory, while flash/repo_atlas.md still exists
        // on disk as a compact-context compatibility artifact.
        '../../index/repo_atlas.generated.md',
        'flash/task_slice.md',
        'flash/relevance_selection.json',
        'flash/flash_input_budget.json',
        'scan/codegraph_usage.json',
      ]));
      expect(relativeArtifacts).not.toContain('flash/repo_atlas.md');
      expect(fs.existsSync(path.join(result.runDir, 'flash', 'repo_atlas.md'))).toBe(true);

      const expectedProgressEventsPath = path.join(result.runDir, 'output', 'progress_events.jsonl');
      expect(result.progressEventsPath).toBe(expectedProgressEventsPath);
      if (result.progressEventsPath === undefined) {
        throw new Error('expected progressEventsPath to be present on successful pipeline result');
      }
      expect(fs.existsSync(result.progressEventsPath)).toBe(true);

      expect(new Set(result.artifacts).size).toBe(result.artifacts.length);
      expect(new Set(relativeArtifacts).size).toBe(relativeArtifacts.length);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
