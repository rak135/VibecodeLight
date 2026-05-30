import { parseTaskIntentJson } from '../../../src/adapters/task_normalizer/task_intent_parser.js';

function validPayload() {
  return {
    normalized_english_task: 'Fix failing tests for the command parser',
    search_hints: ['command parser', 'argument parsing'],
    keyword_groups: {
      core_terms: ['parser'],
      ui_terms: [],
      persistence_terms: [],
      cli_terms: ['flags'],
      test_terms: ['vitest'],
    },
    negative_constraints: ['do not change public behavior'],
    validation_hints: ['pnpm exec vitest run'],
    uncertainties: [],
    warnings: [],
  };
}

describe('parseTaskIntentJson', () => {
  test('returns ok:true with parsed data for valid JSON', () => {
    const result = parseTaskIntentJson(JSON.stringify(validPayload()));

    expect(result).toEqual({
      ok: true,
      data: validPayload(),
    });
  });

  test('returns ok:false with warning for invalid JSON', () => {
    const result = parseTaskIntentJson('{ not valid json');

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/invalid json/i);
  });

  test('strips relevant_files and returns warning', () => {
    const result = parseTaskIntentJson(JSON.stringify({
      ...validPayload(),
      relevant_files: ['src/index.ts'],
    }));

    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/relevant_files/i);
    expect(result.data).toEqual(validPayload());
  });

  test('returns ok:false with warning when normalized_english_task is missing', () => {
    const payload = validPayload() as Record<string, unknown>;
    delete payload.normalized_english_task;

    const result = parseTaskIntentJson(JSON.stringify(payload));

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/normalized_english_task/i);
  });

  test('accepts an empty search_hints array', () => {
    const result = parseTaskIntentJson(JSON.stringify({
      ...validPayload(),
      search_hints: [],
    }));

    expect(result).toEqual({
      ok: true,
      data: {
        ...validPayload(),
        search_hints: [],
      },
    });
  });
});
