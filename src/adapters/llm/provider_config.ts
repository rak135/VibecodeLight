export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  live: boolean;
}

export function loadProviderConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { live?: boolean } = {},
): ProviderConfig | null {
  const provider = env.VIBECODE_PROVIDER?.trim();
  const apiKey = env.VIBECODE_API_KEY?.trim();

  if (!provider && !apiKey) {
    return null;
  }

  if (!provider || !apiKey) {
    return null;
  }

  const model = env.VIBECODE_MODEL?.trim();
  const baseUrl = env.VIBECODE_BASE_URL?.trim();

  return {
    provider,
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    live: opts.live ?? false,
  };
}
