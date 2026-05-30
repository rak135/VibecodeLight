import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { TaskIntent } from '../../../src/adapters/task_normalizer/types.js';

function makeRepo(prefix = 'vibecode-pipeline-codegraph-task-'): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Pipeline CodeGraph task fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'hello.py'), 'print("hello")\n', 'utf8');
  return repoRoot;
}

async function loadPipeline() {
  return (await import('../../../src/core/prompting/pipeline.js')).runPromptPipeline;
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
    test_terms: [],
  },
  negative_constraints: ['do not change CLI output'],
  validation_hints: [],
  uncertainties: [],
  warnings: [],
  model: {
    provider: 'openrouter',
    model: 'gpt-4o-mini',
    live: true,
  },
};

describe('pipeline CodeGraph task enrichment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../../src/adapters/codegraph/codegraph_context.js');
    vi.doUnmock('../../../src/adapters/task_normalizer/index.js');
    vi.resetModules();
  });

  test('when normalizer is enabled and ok CodeGraph receives enriched task text', async () => {
    const repoRoot = makeRepo();
    let capturedTask = '';

    try {
      vi.doMock('../../../src/adapters/codegraph/codegraph_context.js', async () => {
        const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_context.js')>(
          '../../../src/adapters/codegraph/codegraph_context.js',
        );
        return {
          ...actual,
          buildCodeGraphContext: vi.fn(async (input: { task: string; mode?: 'detect-only' | 'use-existing' }) => {
            capturedTask = input.task;
            return {
              ok: true,
              used: false,
              mode: input.mode ?? 'detect-only',
              reason: 'DETECT_ONLY',
              warnings: [],
            };
          }),
        };
      });
      vi.doMock('../../../src/adapters/task_normalizer/index.js', async () => {
        const actual = await vi.importActual<typeof import('../../../src/adapters/task_normalizer/index.js')>(
          '../../../src/adapters/task_normalizer/index.js',
        );
        return {
          ...actual,
          runTaskNormalizer: vi.fn(async () => ENABLED_INTENT),
        };
      });

      const runPromptPipeline = await loadPipeline();
      const result = await runPromptPipeline({
        task: 'Přepni renderer panel',
        repoRoot,
        mock: true,
        taskNormalizerEnabled: true,
      });

      expect(result.ok).toBe(true);
      expect(capturedTask).toContain('Original task:\nPřepni renderer panel');
      expect(capturedTask).toContain('Normalized task:\nToggle the renderer panel behavior');
      expect(capturedTask).toContain('Search hints:\n- toggle\n- renderer');
      expect(capturedTask).toContain('Constraints:\n- do not change CLI output');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('when normalizer is off CodeGraph receives raw task text', async () => {
    const repoRoot = makeRepo();
    let capturedTask = '';

    try {
      vi.doMock('../../../src/adapters/codegraph/codegraph_context.js', async () => {
        const actual = await vi.importActual<typeof import('../../../src/adapters/codegraph/codegraph_context.js')>(
          '../../../src/adapters/codegraph/codegraph_context.js',
        );
        return {
          ...actual,
          buildCodeGraphContext: vi.fn(async (input: { task: string; mode?: 'detect-only' | 'use-existing' }) => {
            capturedTask = input.task;
            return {
              ok: true,
              used: false,
              mode: input.mode ?? 'detect-only',
              reason: 'DETECT_ONLY',
              warnings: [],
            };
          }),
        };
      });

      const runPromptPipeline = await loadPipeline();
      const result = await runPromptPipeline({
        task: 'raw pipeline task',
        repoRoot,
        mock: true,
        taskNormalizerEnabled: false,
      });

      expect(result.ok).toBe(true);
      expect(capturedTask).toBe('raw pipeline task');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
