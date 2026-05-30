export interface TaskIntentEnabled {
  enabled: true;
  ok: true;
  source: 'llm';
  original_task: string;
  original_language: string;
  normalized_english_task: string;
  search_hints: string[];
  keyword_groups: {
    core_terms: string[];
    ui_terms: string[];
    persistence_terms: string[];
    cli_terms: string[];
    test_terms: string[];
    [key: string]: string[];
  };
  negative_constraints: string[];
  validation_hints: string[];
  uncertainties: string[];
  warnings: string[];
  model: {
    provider: string;
    model: string;
    live: boolean;
  };
}

export interface TaskIntentDisabled {
  enabled: false;
  ok: true;
  source: 'disabled';
  original_task: string;
  original_language: 'unknown';
  normalized_english_task: '';
  search_hints: [];
  keyword_groups: Record<string, never>;
  negative_constraints: [];
  validation_hints: [];
  uncertainties: [];
  warnings: [];
}

export interface TaskIntentFallback {
  enabled: true;
  ok: false;
  source: 'fallback';
  original_task: string;
  original_language: 'unknown';
  normalized_english_task: '';
  search_hints: [];
  keyword_groups: Record<string, never>;
  negative_constraints: [];
  validation_hints: [];
  uncertainties: [];
  warnings: string[];
  model?: {
    provider: string;
    model: string;
    live: boolean;
  };
}

export type TaskIntent = TaskIntentEnabled | TaskIntentDisabled | TaskIntentFallback;
