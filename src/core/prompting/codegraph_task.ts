import type { TaskIntent } from '../../adapters/task_normalizer/types.js';

export function buildCodeGraphTask(rawTask: string, taskIntent: TaskIntent): string {
  if (!taskIntent.enabled || !taskIntent.ok) return rawTask;

  const parts = [
    `Original task:\n${rawTask}`,
    `\nNormalized task:\n${taskIntent.normalized_english_task}`,
  ];
  if (taskIntent.search_hints.length > 0) {
    parts.push(`\nSearch hints:\n${taskIntent.search_hints.slice(0, 10).map((hint) => `- ${hint}`).join('\n')}`);
  }
  if (taskIntent.negative_constraints.length > 0) {
    parts.push(`\nConstraints:\n${taskIntent.negative_constraints.slice(0, 5).map((constraint) => `- ${constraint}`).join('\n')}`);
  }
  const combined = parts.join('');
  return combined.length <= 2000 ? combined : rawTask;
}
