export interface ParseTaskIntentJsonResult {
  ok: boolean;
  data?: {
    normalized_english_task: string;
    search_hints: string[];
    keyword_groups: Record<string, string[]>;
    negative_constraints: string[];
    validation_hints: string[];
    uncertainties: string[];
    warnings: string[];
  };
  warning?: string;
}

const REQUIRED_KEYWORD_GROUPS = ['core_terms', 'ui_terms', 'persistence_terms', 'cli_terms', 'test_terms'] as const;
const FILE_PATH_LINE_PATTERN = /\.(ts|js|py|md|json)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsFilePathLikeLine(value: string): boolean {
  return value
    .split(/\r?\n/)
    .some((line) => FILE_PATH_LINE_PATTERN.test(line.trim()));
}

function sanitizeStringArray(fieldName: string, value: unknown, warnings: string[]): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    warnings.push(`Missing or invalid required field: ${fieldName}`);
    return null;
  }

  const sanitized = value.filter((entry) => !containsFilePathLikeLine(entry));
  if (sanitized.length !== value.length) {
    warnings.push(`Stripped file path content from ${fieldName}`);
  }
  return sanitized;
}

function joinWarnings(warnings: string[]): string | undefined {
  return warnings.length > 0 ? warnings.join('; ') : undefined;
}

export function parseTaskIntentJson(raw: string): ParseTaskIntentJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      warning: `Invalid JSON from task normalizer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      warning: 'Task normalizer output must be a JSON object',
    };
  }

  const warnings: string[] = [];
  const payload: Record<string, unknown> = { ...parsed };

  if ('relevant_files' in payload) {
    delete payload.relevant_files;
    warnings.push('Stripped forbidden field: relevant_files');
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'normalized_english_task') {
      continue;
    }
    if (typeof value === 'string' && containsFilePathLikeLine(value)) {
      if (REQUIRED_KEYWORD_GROUPS.includes(key as typeof REQUIRED_KEYWORD_GROUPS[number])) {
        return { ok: false, warning: `Field ${key} contains forbidden file path content` };
      }
      warnings.push(`Ignored field ${key} containing file path content`);
      delete payload[key];
    }
  }

  const normalizedEnglishTask = payload.normalized_english_task;
  if (typeof normalizedEnglishTask !== 'string' || normalizedEnglishTask.trim().length === 0) {
    warnings.push('Missing or invalid required field: normalized_english_task');
    return { ok: false, warning: joinWarnings(warnings) };
  }
  if (containsFilePathLikeLine(normalizedEnglishTask)) {
    return { ok: false, warning: 'normalized_english_task contains forbidden file path content' };
  }

  const searchHints = sanitizeStringArray('search_hints', payload.search_hints, warnings);
  const negativeConstraints = sanitizeStringArray('negative_constraints', payload.negative_constraints, warnings);
  const validationHints = sanitizeStringArray('validation_hints', payload.validation_hints, warnings);
  const uncertainties = sanitizeStringArray('uncertainties', payload.uncertainties, warnings);
  const modelWarnings = sanitizeStringArray('warnings', payload.warnings, warnings);
  const keywordGroupsValue = payload.keyword_groups;

  if (!searchHints || !negativeConstraints || !validationHints || !uncertainties || !modelWarnings) {
    return { ok: false, warning: joinWarnings(warnings) };
  }

  if (!isRecord(keywordGroupsValue)) {
    warnings.push('Missing or invalid required field: keyword_groups');
    return { ok: false, warning: joinWarnings(warnings) };
  }

  const keywordGroups: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(keywordGroupsValue)) {
    const sanitized = sanitizeStringArray(`keyword_groups.${key}`, value, warnings);
    if (!sanitized) {
      return { ok: false, warning: joinWarnings(warnings) };
    }
    keywordGroups[key] = sanitized;
  }

  for (const key of REQUIRED_KEYWORD_GROUPS) {
    if (!Array.isArray(keywordGroups[key])) {
      warnings.push(`Missing or invalid required field: keyword_groups.${key}`);
      return { ok: false, warning: joinWarnings(warnings) };
    }
  }

  const result: ParseTaskIntentJsonResult = {
    ok: true,
    data: {
      normalized_english_task: normalizedEnglishTask,
      search_hints: searchHints,
      keyword_groups: keywordGroups,
      negative_constraints: negativeConstraints,
      validation_hints: validationHints,
      uncertainties,
      warnings: modelWarnings,
    },
  };

  const warning = joinWarnings(warnings);
  if (warning) {
    result.warning = warning;
  }

  return result;
}
