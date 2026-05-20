import fs from 'fs';
import path from 'path';

import type { SelectedSkillsFile, SelectedSkillEntry } from './selected_skills.js';

export interface WriteSelectedSkillContentsResult {
  path: string;
  warnings: string[];
}

function normalizeMarkdownContent(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function renderSkillBlock(skill: SelectedSkillEntry, warnings: string[]): string {
  const lines = [
    `## ${skill.id}`,
    '',
    `**Source:** ${skill.source}  `,
    `**Path:** ${skill.path}`,
    '',
  ];

  if (!skill.path || !fs.existsSync(skill.path)) {
    const warning = `selected skill "${skill.id}" path is missing: ${skill.path}`;
    warnings.push(warning);
    return [...lines, `**Warning:** ${warning}`, '', '---', ''].join('\n');
  }

  const skillMdPath = path.join(skill.path, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    const warning = `selected skill "${skill.id}" is missing SKILL.md at ${skillMdPath}`;
    warnings.push(warning);
    return [...lines, `**Warning:** ${warning}`, '', '---', ''].join('\n');
  }

  try {
    const content = normalizeMarkdownContent(fs.readFileSync(skillMdPath, 'utf8'));
    return [...lines, content, '---', ''].join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning = `failed to read selected skill "${skill.id}" at ${skillMdPath}: ${message}`;
    warnings.push(warning);
    return [...lines, `**Warning:** ${warning}`, '', '---', ''].join('\n');
  }
}

function renderMissingSkillBlock(id: string, warnings: string[]): string {
  const warning = `Missing skill metadata for selected skill "${id}"; it was not found in skills_catalog.json.`;
  warnings.push(warning);
  return [
    `## ${id}`,
    '',
    `**Warning:** ${warning}`,
    '',
    '---',
    '',
  ].join('\n');
}

export function writeSelectedSkillContents(
  runDir: string,
  selectedSkills: SelectedSkillsFile,
): WriteSelectedSkillContentsResult {
  const warnings: string[] = [];
  const blocks: string[] = [];
  const sortedSkills = [...selectedSkills.selected_skills].sort((a, b) => a.id.localeCompare(b.id));
  const sortedMissing = [...selectedSkills.missing_skills].sort((a, b) => a.localeCompare(b));

  for (const skill of sortedSkills) {
    blocks.push(renderSkillBlock(skill, warnings));
  }
  for (const id of sortedMissing) {
    blocks.push(renderMissingSkillBlock(id, warnings));
  }

  const output = ['# Selected Skill Contents', '', ...blocks].join('\n');
  const outputPath = path.join(runDir, 'skills', 'selected_skill_contents.md');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');

  return { path: outputPath, warnings };
}
