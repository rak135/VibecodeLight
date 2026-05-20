import fs from 'fs';
import path from 'path';

import type { FlashOutputSection } from './flash_output_contract.js';
import type { SkillMetadata, SkillsCatalog, SkillScope, SkillSource } from '../models/index.js';

export interface SelectedSkillEntry {
  id: string;
  title: string;
  source: SkillSource;
  scope: SkillScope;
  path: string;
}

export interface SelectedSkillsFile {
  run_id: string;
  selected_skills: SelectedSkillEntry[];
  warnings: string[];
  missing_skills: string[];
}

export interface WriteSelectedSkillsResult {
  path: string;
  data: SelectedSkillsFile;
}

function getSectionBody(sections: FlashOutputSection[], name: string): string {
  return sections.find((section) => section.name === name)?.body ?? '';
}

function normalizeSkillId(raw: string): string {
  return raw
    .trim()
    .replace(/^`+|`+$/g, '')
    .trim();
}

export function extractSelectedSkillIds(sections: FlashOutputSection[]): string[] {
  const body = getSectionBody(sections, 'Selected Skills');
  const ids = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => line.slice(2).trim())
    .map((item) => item.split(' — ')[0].trim())
    .map(normalizeSkillId)
    .filter((id) => id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function readRunId(runDir: string): string {
  const manifestPath = path.join(runDir, 'run_manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { run_id?: unknown };
    if (typeof manifest.run_id === 'string' && manifest.run_id.trim()) {
      return manifest.run_id;
    }
  } catch {
    // Fall through to directory-name fallback. The finalizer performs stricter
    // validation of required run inputs; selected skill serialization remains tolerant.
  }
  return path.basename(runDir);
}

function toSelectedSkillEntry(skill: SkillMetadata): SelectedSkillEntry {
  return {
    id: skill.id,
    title: skill.title,
    source: skill.source,
    scope: skill.scope,
    path: skill.path,
  };
}

export function writeSelectedSkills(
  runDir: string,
  sections: FlashOutputSection[],
  catalog: SkillsCatalog,
): WriteSelectedSkillsResult {
  const selectedIds = extractSelectedSkillIds(sections);
  const catalogById = new Map(catalog.skills.map((skill) => [skill.id, skill]));
  const warnings: string[] = [];
  const selected_skills: SelectedSkillEntry[] = [];
  const missing_skills: string[] = [];

  for (const id of selectedIds) {
    const skill = catalogById.get(id);
    if (!skill) {
      missing_skills.push(id);
      warnings.push(`selected skill "${id}" was not found in skills_catalog.json`);
      continue;
    }
    selected_skills.push(toSelectedSkillEntry(skill));
  }

  selected_skills.sort((a, b) => a.id.localeCompare(b.id));
  missing_skills.sort((a, b) => a.localeCompare(b));
  warnings.sort((a, b) => a.localeCompare(b));

  const data: SelectedSkillsFile = {
    run_id: readRunId(runDir),
    selected_skills,
    warnings,
    missing_skills,
  };

  const outputPath = path.join(runDir, 'skills', 'selected_skills.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  return { path: outputPath, data };
}
