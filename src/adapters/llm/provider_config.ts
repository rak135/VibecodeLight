/**
 * Provider configuration carrying the resolved secret for adapter use. NEVER
 * serialize this object — it holds the API key value. The safe, secret-free view
 * is ConfigResolution in src/core/config.
 */
export interface ProviderConfig {
  /** Provider id from the registry, e.g. "openrouter". */
  provider: string;
  /** Human-readable provider label, e.g. "OpenRouter". */
  providerLabel?: string;
  apiKey: string;
  /** The NAME of the env variable the key came from. Never the value. */
  apiKeyEnv?: string;
  model?: string;
  modelLabel?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  live: boolean;
}
