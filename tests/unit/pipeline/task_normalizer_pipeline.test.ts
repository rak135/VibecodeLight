import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TaskIntent } from '../../../src/adapters/task_normalizer/types.js';

function makeRepo(prefix = 'vibecode-task-normalizer-pipeline-'): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Task normalizer pipeline fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'hello.py'), 'print("hello")\n', 'utf8');
  return repoRoot;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

async function loadPipeline() {
  return (await import('../../../src/core/prompting/pipeline.js')).runPromptPipeline;
}

const VALID_TASK_INTENT: TaskIntent = {
  enabled: true,
  ok: true,
  source: 'llm',
  original_task: 'Oprav parser příkazů',
  original_language: 'cs',
  normalized_english_task: 'Fix command parser behavior',
  search_hints: ['command parser', 'flags', 'argv'],
  keyword_groups: {
    core_terms: ['parser'],
    ui_terms: [],
    persistence_terms: [],
    cli_terms: ['flags', 'argv'],
    test_terms: ['vitest'],
  },
  negative_constraints: ['do not change CLI output'],
  validation_hints: ['pnpm exec vitest run tests/unit/pipeline/task_normalizer_pipeline.test.ts'],
  uncertainties: [],
  warnings: [],
  model: {
    provider: 'openrouter',
    model: 'gpt-4o-mini',
    live: true,
  },
};

describe('task normalizer pipeline integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../../src/adapters/task_normalizer/index.js');
    vi.resetModules();
  });

  test('taskNormalizerEnabled=false writes disabled task intent and empty scanner signals', async () => {
    const repoRoot = makeRepo();

    try {
      const runPromptPipeline = await loadPipeline();
      const result = await runPromptPipeline({
        task: 'disabled normalizer test',
        repoRoot,
        mock: true,
        taskNormalizerEnabled: false,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const taskIntentPath = path.join(result.runDir, 'task_intent.json');
      const scannerConfigPath = path.join(result.runDir, 'scanner_config.json');
      const taskIntent = readJson<TaskIntent>(taskIntentPath);
      const scannerConfig = readJson<Record<string, unknown>>(scannerConfigPath);

      expect(taskIntent).toMatchObject({
        enabled: false,
        ok: true,
        source: 'disabled',
      });
      expect(result.taskIntentPath).toBe(taskIntentPath);
      expect(result.taskNormalizerEnabled).toBe(false);
      expect(result.taskNormalizerOk).toBe(true);
      expect(result.taskNormalizerLanguage).toBe('unknown');
      expect(result.artifacts).toEqual(expect.arrayContaining([
        taskIntentPath,
        path.join(result.runDir, 'task_intent.md'),
      ]));

      expect(scannerConfig.normalized_english_task).toBe('');
      expect(scannerConfig.search_hints).toEqual([]);
      expect(scannerConfig.keyword_groups).toEqual({});
      expect(scannerConfig._provenance_note).toBe(
        'normalized signals from Task Normalizer; Python scanner uses these for expanded keyword matching',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('taskNormalizerEnabled=true with mock=true falls back and pipeline still succeeds', async () => {
    const repoRoot = makeRepo();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const runPromptPipeline = await loadPipeline();
      const result = await runPromptPipeline({
        task: 'fallback normalizer test',
        repoRoot,
        mock: true,
        taskNormalizerEnabled: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const taskIntent = readJson<TaskIntent>(path.join(result.runDir, 'task_intent.json'));
      const scannerConfig = readJson<Record<string, unknown>>(path.join(result.runDir, 'scanner_config.json'));

      expect(taskIntent).toMatchObject({
        enabled: true,
        ok: false,
        source: 'fallback',
      });
      expect(taskIntent.warnings[0]).toMatch(/providerConfig/i);
      expect(warnSpy).toHaveBeenCalled();
      expect(result.taskNormalizerEnabled).toBe(true);
      expect(result.taskNormalizerOk).toBe(false);
      expect(result.taskNormalizerLanguage).toBe('unknown');
      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/providerConfig/i)]));
      expect(fs.existsSync(result.finalPromptPath)).toBe(true);

      expect(scannerConfig.normalized_english_task).toBe('');
      expect(scannerConfig.search_hints).toEqual([]);
      expect(scannerConfig.keyword_groups).toEqual({});
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('taskNormalizerEnabled=true with fake normalizer adapter writes populated scanner signals', async () => {
    const repoRoot = makeRepo();

    try {
      vi.doMock('../../../src/adapters/task_normalizer/index.js', async () => {
        const actual = await vi.importActual<typeof import('../../../src/adapters/task_normalizer/index.js')>(
          '../../../src/adapters/task_normalizer/index.js',
        );
        return {
          ...actual,
          runTaskNormalizer: vi.fn(async () => VALID_TASK_INTENT),
        };
      });

      const runPromptPipeline = await loadPipeline();
      const result = await runPromptPipeline({
        task: 'mocked normalizer success',
        repoRoot,
        mock: true,
        taskNormalizerEnabled: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const taskIntent = readJson<TaskIntent>(path.join(result.runDir, 'task_intent.json'));
      const scannerConfig = readJson<Record<string, unknown>>(path.join(result.runDir, 'scanner_config.json'));

      expect(taskIntent).toEqual(VALID_TASK_INTENT);
      expect(result.taskNormalizerEnabled).toBe(true);
      expect(result.taskNormalizerOk).toBe(true);
      expect(result.taskNormalizerLanguage).toBe('cs');
      expect(scannerConfig.normalized_english_task).toBe('Fix command parser behavior');
      expect(scannerConfig.search_hints).toEqual(['command parser', 'flags', 'argv']);
      expect(scannerConfig.keyword_groups).toEqual(VALID_TASK_INTENT.keyword_groups);
      expect(result.warnings.join('\n')).not.toMatch(/providerConfig/i);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('taskNormalizerEnabled omitted defaults to disabled behavior', async () => {
    const repoRoot = makeRepo();

    try {
      const runPromptPipeline = await loadPipeline();
      const result = await runPromptPipeline({
        task: 'default disabled normalizer test',
        repoRoot,
        mock: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const taskIntent = readJson<TaskIntent>(path.join(result.runDir, 'task_intent.json'));
      const scannerConfig = readJson<Record<string, unknown>>(path.join(result.runDir, 'scanner_config.json'));

      expect(taskIntent).toMatchObject({
        enabled: false,
        ok: true,
        source: 'disabled',
      });
      expect(result.taskNormalizerEnabled).toBe(false);
      expect(result.taskNormalizerOk).toBe(true);
      expect(scannerConfig.normalized_english_task).toBe('');
      expect(scannerConfig.search_hints).toEqual([]);
      expect(scannerConfig.keyword_groups).toEqual({});
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
