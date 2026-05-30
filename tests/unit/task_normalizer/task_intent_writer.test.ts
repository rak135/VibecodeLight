import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TaskIntent, TaskIntentDisabled, TaskIntentEnabled, TaskIntentFallback } from '../../../src/adapters/task_normalizer/types.js';
import { writeTaskIntentArtifacts } from '../../../src/adapters/task_normalizer/task_intent_writer.js';

function readJson(filePath: string): TaskIntent {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TaskIntent;
}

describe('writeTaskIntentArtifacts', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-task-intent-'));
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('writes deterministic disabled JSON and markdown artifacts', () => {
    const intent: TaskIntentDisabled = {
      enabled: false,
      ok: true,
      source: 'disabled',
      original_task: 'Do the thing',
      original_language: 'unknown',
      normalized_english_task: '',
      search_hints: [],
      keyword_groups: {},
      negative_constraints: [],
      validation_hints: [],
      uncertainties: [],
      warnings: [],
    };

    const result = writeTaskIntentArtifacts(runDir, intent);

    expect(result.jsonPath).toBe(path.join(runDir, 'task_intent.json'));
    expect(result.mdPath).toBe(path.join(runDir, 'task_intent.md'));
    expect(readJson(result.jsonPath)).toEqual(intent);
    expect(fs.readFileSync(result.mdPath, 'utf8')).toBe('# Task Intent\n\nTask Normalizer: off\nUsing raw user task only.\n');
  });

  test('writes enabled JSON and markdown artifacts with all fields', () => {
    const intent: TaskIntentEnabled = {
      enabled: true,
      ok: true,
      source: 'llm',
      original_task: 'Oprav parser argumentů',
      original_language: 'cs',
      normalized_english_task: 'Fix argument parser behavior',
      search_hints: ['argument parser', 'flags'],
      keyword_groups: {
        core_terms: ['parser'],
        ui_terms: [],
        persistence_terms: [],
        cli_terms: ['flags'],
        test_terms: ['vitest'],
      },
      negative_constraints: ['do not change cli UX'],
      validation_hints: ['pnpm exec vitest run'],
      uncertainties: ['exact failing case unknown'],
      warnings: ['translated from non-English input'],
      model: {
        provider: 'openrouter',
        model: 'gpt-4o-mini',
        live: true,
      },
    };

    const result = writeTaskIntentArtifacts(runDir, intent);
    const markdown = fs.readFileSync(result.mdPath, 'utf8');

    expect(readJson(result.jsonPath)).toEqual(intent);
    expect(markdown).toContain('# Task Intent');
    expect(markdown).toContain('Task Normalizer: on');
    expect(markdown).toContain('Source: llm');
    expect(markdown).toContain('Original language: cs');
    expect(markdown).toContain('Normalized English task');
    expect(markdown).toContain('Fix argument parser behavior');
    expect(markdown).toContain('Search hints');
    expect(markdown).toContain('argument parser');
    expect(markdown).toContain('Keyword groups');
    expect(markdown).toContain('Negative constraints');
    expect(markdown).toContain('Validation hints');
    expect(markdown).toContain('Uncertainties');
    expect(markdown).toContain('Warnings');
    expect(markdown).toContain('Model');
    expect(markdown).toContain('openrouter');
    expect(markdown).toContain('gpt-4o-mini');
  });

  test('writes fallback JSON and markdown artifacts with failure info', () => {
    const intent: TaskIntentFallback = {
      enabled: true,
      ok: false,
      source: 'fallback',
      original_task: 'Fix parser',
      original_language: 'unknown',
      normalized_english_task: '',
      search_hints: [],
      keyword_groups: {},
      negative_constraints: [],
      validation_hints: [],
      uncertainties: [],
      warnings: ['task normalizer parse failed: invalid json'],
      model: {
        provider: 'openrouter',
        model: 'gpt-4o-mini',
        live: true,
      },
    };

    const result = writeTaskIntentArtifacts(runDir, intent);
    const markdown = fs.readFileSync(result.mdPath, 'utf8');

    expect(readJson(result.jsonPath)).toEqual(intent);
    expect(markdown).toContain('# Task Intent');
    expect(markdown).toContain('Task Normalizer: fallback');
    expect(markdown).toContain('Failure reason');
    expect(markdown).toContain('task normalizer parse failed: invalid json');
  });
});
