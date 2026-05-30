import type { ProviderConfig } from '../../../src/adapters/llm/provider_config.js';
import { runTaskNormalizer } from '../../../src/adapters/task_normalizer/task_normalizer_adapter.js';

const providerConfig: ProviderConfig = {
  provider: 'openrouter',
  apiKey: 'secret-api-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4o-mini',
  live: true,
};

function validPayload() {
  return {
    normalized_english_task: 'Fix command parser behavior',
    search_hints: ['command parser', 'flags'],
    keyword_groups: {
      core_terms: ['parser'],
      ui_terms: [],
      persistence_terms: [],
      cli_terms: ['flags'],
      test_terms: ['vitest'],
    },
    negative_constraints: ['do not change user-facing behavior'],
    validation_hints: ['pnpm exec vitest run'],
    uncertainties: [],
    warnings: [],
  };
}

describe('runTaskNormalizer', () => {
  test('returns deterministic disabled intent and does not call LLM when enabled=false', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(validPayload()) } }] }),
      } as Response;
    };

    const result = await runTaskNormalizer({
      task: 'Fix parser',
      enabled: false,
      providerConfig,
      fetchFn: fakeFetch as typeof fetch,
    });

    expect(result).toEqual({
      enabled: false,
      ok: true,
      source: 'disabled',
      original_task: 'Fix parser',
      original_language: 'unknown',
      normalized_english_task: '',
      search_hints: [],
      keyword_groups: {},
      negative_constraints: [],
      validation_hints: [],
      uncertainties: [],
      warnings: [],
    });
    expect(calls).toBe(0);
  });

  test('returns fallback with warning when enabled=true and providerConfig is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await runTaskNormalizer({
        task: 'Fix parser',
        enabled: true,
      });

      expect(result.ok).toBe(false);
      expect(result.source).toBe('fallback');
      expect(result.warnings[0]).toMatch(/providerConfig/i);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('returns enabled intent when provider responds with valid JSON', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validPayload()) } }] }),
    }) as Response;

    const result = await runTaskNormalizer({
      task: 'Fix parser',
      enabled: true,
      providerConfig,
      fetchFn: fakeFetch as typeof fetch,
      modelInfo: { provider: 'openrouter', model: 'gpt-4o-mini' },
    });

    expect(result).toEqual({
      enabled: true,
      ok: true,
      source: 'llm',
      original_task: 'Fix parser',
      original_language: 'en',
      normalized_english_task: 'Fix command parser behavior',
      search_hints: ['command parser', 'flags'],
      keyword_groups: {
        core_terms: ['parser'],
        ui_terms: [],
        persistence_terms: [],
        cli_terms: ['flags'],
        test_terms: ['vitest'],
      },
      negative_constraints: ['do not change user-facing behavior'],
      validation_hints: ['pnpm exec vitest run'],
      uncertainties: [],
      warnings: [],
      model: {
        provider: 'openrouter',
        model: 'gpt-4o-mini',
        live: true,
      },
    });
  });

  test('returns fallback with warning when provider responds with invalid JSON', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{invalid json' } }] }),
    }) as Response;

    const result = await runTaskNormalizer({
      task: 'Fix parser',
      enabled: true,
      providerConfig,
      fetchFn: fakeFetch as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.source).toBe('fallback');
    expect(result.warnings[0]).toMatch(/invalid json/i);
  });

  test('returns fallback with warning when provider throws', async () => {
    const fakeFetch = async () => {
      throw new Error('network down');
    };

    const result = await runTaskNormalizer({
      task: 'Fix parser',
      enabled: true,
      providerConfig,
      fetchFn: fakeFetch as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.source).toBe('fallback');
    expect(result.warnings[0]).toMatch(/network down/i);
  });

  test('detects Czech task language', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validPayload()) } }] }),
    }) as Response;

    const result = await runTaskNormalizer({
      task: 'Oprav špatné chování parseru příkazů',
      enabled: true,
      providerConfig,
      fetchFn: fakeFetch as typeof fetch,
    });

    expect(result.original_language).toBe('cs');
  });

  test('detects English task language', async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validPayload()) } }] }),
    }) as Response;

    const result = await runTaskNormalizer({
      task: 'Fix parser behavior',
      enabled: true,
      providerConfig,
      fetchFn: fakeFetch as typeof fetch,
    });

    expect(result.original_language).toBe('en');
  });
});
