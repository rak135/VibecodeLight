import fs from 'fs';
import path from 'path';

export interface RunContextSummarySkill {
  id: string;
  title: string;
}

export interface RunContextSummary {
  relevant_files: string[];
  files_to_read_with_tools: string[];
  commands_to_run: string[];
  cautions: string[];
  selected_skills: RunContextSummarySkill[];
}

function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Read a safe, display-ready summary of a run's flash context for inspectors.
 *
 * It only re-reads artifacts the pipeline already produced
 * (`flash/flash_output_meta.json` and `skills/selected_skills.json`). It invents
 * no data, performs no model calls, and tolerates missing/partial runs by
 * returning empty lists.
 */
export function readRunContextSummary(runDir: string): RunContextSummary {
  const meta = readJson<Record<string, unknown>>(path.join(runDir, 'flash', 'flash_output_meta.json')) ?? {};
  const selected = readJson<{ selected_skills?: unknown }>(path.join(runDir, 'skills', 'selected_skills.json'));

  const selectedSkills: RunContextSummarySkill[] = Array.isArray(selected?.selected_skills)
    ? selected.selected_skills
        .map((entry): RunContextSummarySkill | undefined => {
          if (entry && typeof entry === 'object') {
            const id = (entry as { id?: unknown }).id;
            const title = (entry as { title?: unknown }).title;
            if (typeof id === 'string' && id.length > 0) {
              return { id, title: typeof title === 'string' && title.length > 0 ? title : id };
            }
          }
          return undefined;
        })
        .filter((skill): skill is RunContextSummarySkill => skill !== undefined)
    : [];

  return {
    relevant_files: stringArray(meta.relevant_files),
    files_to_read_with_tools: stringArray(meta.files_to_read_with_tools),
    commands_to_run: stringArray(meta.commands_to_run),
    cautions: stringArray(meta.cautions),
    selected_skills: selectedSkills,
  };
}
