import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { buildCompactFlashContext } from '../../../src/core/context/index.js';
import type { TaskIntent } from '../../../src/adapters/task_normalizer/types.js';

function makeRunFixture(): { repoRoot: string; runDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-task-intent-'));
  const runDir = path.join(repoRoot, '.vibecode', 'runs', '20260530_000001');
  fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'Implement renderer toggle behavior\n', 'utf8');
  fs.writeFileSync(
    path.join(runDir, 'scan', 'file_inventory.json'),
    JSON.stringify({
      files: [
        { path: 'src/aaa.ts' },
        { path: 'src/ui/renderer_toggle.ts' },
        { path: 'src/core/context/flash_compaction.ts' },
        { path: 'tests/core/context/flash_compaction_task_intent.test.ts' },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'scan', 'tests.json'),
    JSON.stringify({
      tests: [
        { path: 'tests/core/context/flash_compaction_task_intent.test.ts' },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'scan', 'keyword_hits.json'),
    JSON.stringify({
      keyword_hits: [
        { path: 'src/core/context/flash_compaction.ts', match_type: 'path' },
      ],
    }),
    'utf8',
  );
  return { repoRoot, runDir };
}

const ENABLED_INTENT: TaskIntent = {
  enabled: true,
  ok: true,
  source: 'llm',
  original_task: 'Přepni renderer panel',
  original_language: 'cs',
  normalized_english_task: 'Toggle the renderer panel behavior',
  search_hints: ['toggle', 'renderer'],
  keyword_groups: {
    core_terms: ['toggle'],
    ui_terms: ['renderer'],
    persistence_terms: [],
    cli_terms: [],
    test_terms: ['flash'],
  },
  negative_constraints: ['do not change unrelated CLI behavior'],
  validation_hints: ['pnpm test'],
  uncertainties: [],
  warnings: [],
  model: {
    provider: 'openrouter',
    model: 'gpt-4o-mini',
    live: true,
  },
};

const DISABLED_INTENT: TaskIntent = {
  enabled: false,
  ok: true,
  source: 'disabled',
  original_task: 'Disable normalizer',
  original_language: 'unknown',
  normalized_english_task: '',
  search_hints: [],
  keyword_groups: {},
  negative_constraints: [],
  validation_hints: [],
  uncertainties: [],
  warnings: [],
};

const FALLBACK_INTENT: TaskIntent = {
  enabled: true,
  ok: false,
  source: 'fallback',
  original_task: 'Fallback normalizer',
  original_language: 'unknown',
  normalized_english_task: '',
  search_hints: [],
  keyword_groups: {},
  negative_constraints: [],
  validation_hints: [],
  uncertainties: [],
  warnings: ['task normalizer provider failed'],
};

describe('flash compaction task intent rendering', () => {
  test('disabled taskIntent renders Task Normalizer off in task slice', () => {
    const fixture = makeRunFixture();
    try {
      const result = buildCompactFlashContext({
        run_id: '20260530_000001',
        task: 'Investigate flash context ranking',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        taskIntent: DISABLED_INTENT,
      });

      expect(result.taskSlice).toContain('## Task Intent');
      expect(result.taskSlice).toContain('Task Normalizer: off');
      expect(result.taskSlice).toContain('Using raw user task only.');
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  test('enabled taskIntent renders normalized task and search hints in task slice', () => {
    const fixture = makeRunFixture();
    try {
      const result = buildCompactFlashContext({
        run_id: '20260530_000001',
        task: 'Přepni renderer panel',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        taskIntent: ENABLED_INTENT,
      });

      expect(result.taskSlice).toContain('Task Normalizer: on');
      expect(result.taskSlice).toContain('Original task language: cs');
      expect(result.taskSlice).toContain('Normalized English task:');
      expect(result.taskSlice).toContain('Toggle the renderer panel behavior');
      expect(result.taskSlice).toContain('Search hints:');
      expect(result.taskSlice).toContain('- toggle');
      expect(result.taskSlice).toContain('- renderer');
      expect(result.taskSlice).toContain('Constraints:');
      expect(result.taskSlice).toContain('- do not change unrelated CLI behavior');
      expect(result.taskSlice).toContain('Validation hints:');
      expect(result.taskSlice).toContain('- pnpm test');
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  test('fallback taskIntent renders Task Normalizer fallback state', () => {
    const fixture = makeRunFixture();
    try {
      const result = buildCompactFlashContext({
        run_id: '20260530_000001',
        task: 'Handle fallback mode',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        taskIntent: FALLBACK_INTENT,
      });

      expect(result.taskSlice).toContain('Task Normalizer: fallback (failed)');
      expect(result.taskSlice).toContain('- task normalizer provider failed');
      expect(result.taskSlice).toContain('Using raw user task only.');
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  test('task slice removes score display for ranked relevant files and tests', () => {
    const fixture = makeRunFixture();
    try {
      const result = buildCompactFlashContext({
        run_id: '20260530_000001',
        task: 'renderer flash context',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        taskIntent: ENABLED_INTENT,
      });

      expect(result.taskSlice).toContain('## Ranked Relevant Files');
      expect(result.taskSlice).toContain('selected by:');
      expect(result.taskSlice).not.toMatch(/\(score \d+\)/);
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  test('search hints expand relevance scoring tokens', () => {
    const fixture = makeRunFixture();
    try {
      const result = buildCompactFlashContext({
        run_id: '20260530_000001',
        task: 'Investigate docs only',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        taskIntent: ENABLED_INTENT,
      });

      expect(result.relevanceSelection.selected_files.map((item) => item.path)).toContain('src/ui/renderer_toggle.ts');
      const rendererItem = result.relevanceSelection.selected_files.find((item) => item.path === 'src/ui/renderer_toggle.ts');
      expect(rendererItem?.reasons.join('; ')).toContain("path matches task term 'toggle'");
      expect(rendererItem?.reasons.join('; ')).toContain("matched search hint: toggle");
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });
});
