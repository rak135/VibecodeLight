import fs from 'fs';
import path from 'path';

import type { TaskIntent, TaskIntentEnabled, TaskIntentFallback } from './types.js';

function renderList(items: string[]): string {
  if (items.length === 0) {
    return '- (none)';
  }
  return items.map((item) => `- ${item}`).join('\n');
}

function renderKeywordGroups(keywordGroups: Record<string, string[]>): string {
  const entries = Object.entries(keywordGroups);
  if (entries.length === 0) {
    return '- (none)';
  }

  return entries.map(([group, values]) => `- ${group}: ${values.length > 0 ? values.join(', ') : '(none)'}`).join('\n');
}

function renderEnabledMarkdown(intent: TaskIntentEnabled): string {
  return [
    '# Task Intent',
    '',
    'Task Normalizer: on',
    `Source: ${intent.source}`,
    `Original task: ${intent.original_task}`,
    `Original language: ${intent.original_language}`,
    '',
    'Normalized English task',
    intent.normalized_english_task,
    '',
    'Search hints',
    renderList(intent.search_hints),
    '',
    'Keyword groups',
    renderKeywordGroups(intent.keyword_groups),
    '',
    'Negative constraints',
    renderList(intent.negative_constraints),
    '',
    'Validation hints',
    renderList(intent.validation_hints),
    '',
    'Uncertainties',
    renderList(intent.uncertainties),
    '',
    'Warnings',
    renderList(intent.warnings),
    '',
    'Model',
    `- provider: ${intent.model.provider}`,
    `- model: ${intent.model.model}`,
    `- live: ${String(intent.model.live)}`,
    '',
  ].join('\n');
}

function renderFallbackMarkdown(intent: TaskIntentFallback): string {
  return [
    '# Task Intent',
    '',
    'Task Normalizer: fallback',
    `Original task: ${intent.original_task}`,
    'Using raw user task after normalization failure.',
    '',
    'Failure reason',
    renderList(intent.warnings),
    '',
  ].join('\n');
}

function renderMarkdown(intent: TaskIntent): string {
  if (!intent.enabled) {
    return '# Task Intent\n\nTask Normalizer: off\nUsing raw user task only.\n';
  }

  if (intent.ok) {
    return renderEnabledMarkdown(intent);
  }

  return renderFallbackMarkdown(intent as TaskIntentFallback);
}

export function writeTaskIntentArtifacts(runDir: string, intent: TaskIntent): {
  jsonPath: string;
  mdPath: string;
} {
  fs.mkdirSync(runDir, { recursive: true });

  const jsonPath = path.join(runDir, 'task_intent.json');
  const mdPath = path.join(runDir, 'task_intent.md');

  fs.writeFileSync(jsonPath, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(intent), 'utf8');

  return { jsonPath, mdPath };
}
