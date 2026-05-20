import { loadProviderConfig } from '../../../src/adapters/llm/provider_config';

describe('loadProviderConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VIBECODE_PROVIDER;
    delete process.env.VIBECODE_API_KEY;
    delete process.env.VIBECODE_MODEL;
    delete process.env.VIBECODE_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns null when no env vars set', () => {
    expect(loadProviderConfig()).toBeNull();
  });

  test('returns config when env vars are set', () => {
    process.env.VIBECODE_PROVIDER = 'openrouter';
    process.env.VIBECODE_API_KEY = 'test-key';
    process.env.VIBECODE_MODEL = 'test/model';
    process.env.VIBECODE_BASE_URL = 'https://example.invalid/api';

    expect(loadProviderConfig()).toEqual({
      provider: 'openrouter',
      apiKey: 'test-key',
      model: 'test/model',
      baseUrl: 'https://example.invalid/api',
      live: false,
    });
  });
});
