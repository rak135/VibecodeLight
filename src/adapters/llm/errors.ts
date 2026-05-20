export class LlmAdapterError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly details: string[];

  constructor(message: string, opts: { code?: string; path?: string; details?: string[] } = {}) {
    super(message);
    this.name = 'LlmAdapterError';
    this.code = opts.code ?? 'LLM_ADAPTER_ERROR';
    this.path = opts.path;
    this.details = opts.details ?? [];
  }
}

export class ToolAccessError extends LlmAdapterError {
  constructor(message: string, opts: { path?: string; details?: string[] } = {}) {
    super(message, { code: 'TOOL_ACCESS_REFUSED', path: opts.path, details: opts.details });
    this.name = 'ToolAccessError';
  }
}

export class ProviderNotConfiguredError extends LlmAdapterError {
  constructor(message = 'No flash provider configured. Use --mock for deterministic local runs or pass --live with provider configuration.', opts: { path?: string; details?: string[] } = {}) {
    super(message, { code: 'PROVIDER_NOT_CONFIGURED', path: opts.path, details: opts.details });
    this.name = 'ProviderNotConfiguredError';
  }
}
