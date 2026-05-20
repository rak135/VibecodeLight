import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseFlashOutput } from '../../../src/core/context/markdown_flash_output_parser';
import { writeSelectedSkills } from '../../../src/core/context/selected_skills';
import type { SkillsCatalog } from '../../../src/core/models';

function tmpRunDir(): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-selected-skills-'));
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify({
    run_id: 'run-selected-skills',
    created_at: '2026-01-01T00:00:00.000Z',
    task: 'selected skills test',
    status: 'done',
  }, null, 2));
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  return runDir;
}

function flashOutput(selectedSkillsBody: string): string {
  return [
    '# Task Summary',
    'Task summary body.',
    '',
    '# Relevant Files',
    '- README.md',
    '',
    '# Files To Read With Tools',
    '- README.md',
    '',
    '# Relevant Tests',
    '- pnpm test',
    '',
    '# Commands To Run',
    '- pnpm test',
    '',
    '# Selected Skills',
    selectedSkillsBody,
    '',
    '# Cautions',
    '- Be careful.',
    '',
    '# Context Pack',
    'Context body.',
    '',
  ].join('\n');
}

function catalog(runDir: string): SkillsCatalog {
  return {
    generated_at: '2026-01-01T00:00:00.000Z',
    warnings: [],
    skills: [
      {
        id: 'z-skill',
        title: 'Z Skill',
        summary: 'Z summary',
        tags: [],
        source: 'user-profile',
        scope: 'user',
        path: path.join(runDir, 'source-skills', 'z-skill'),
        has_skill_md: true,
        has_skill_yaml: false,
        warnings: [],
      },
      {
        id: 'a-skill',
        title: 'A Skill',
        summary: 'A summary',
        tags: [],
        source: 'project',
        scope: 'project',
        path: path.join(runDir, 'source-skills', 'a-skill'),
        has_skill_md: true,
        has_skill_yaml: true,
        warnings: [],
      },
    ],
  };
}

function parsedSections(selectedSkillsBody: string) {
  const parsed = parseFlashOutput(flashOutput(selectedSkillsBody));
  expect(parsed.ok).toBe(true);
  return parsed.sections;
}

describe('writeSelectedSkills', () => {
  test('selected skills extracted from flash_output.md sections', () => {
    const runDir = tmpRunDir();

    const result = writeSelectedSkills(runDir, parsedSections('- z-skill — useful\n- a-skill'), catalog(runDir));

    expect(result.data.selected_skills.map((skill) => skill.id)).toEqual(['a-skill', 'z-skill']);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('selected_skills.json written with run_id, selected_skills array, warnings, missing_skills', () => {
    const runDir = tmpRunDir();

    const result = writeSelectedSkills(runDir, parsedSections('- a-skill\n- missing-skill'), catalog(runDir));
    const saved = JSON.parse(fs.readFileSync(result.path, 'utf8'));

    expect(saved).toMatchObject({
      run_id: 'run-selected-skills',
      selected_skills: [expect.objectContaining({ id: 'a-skill' })],
      missing_skills: ['missing-skill'],
    });
    expect(Array.isArray(saved.warnings)).toBe(true);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('missing skill ID recorded in missing_skills without crashing', () => {
    const runDir = tmpRunDir();

    const result = writeSelectedSkills(runDir, parsedSections('- unknown-skill-id'), catalog(runDir));

    expect(result.data.selected_skills).toEqual([]);
    expect(result.data.missing_skills).toEqual(['unknown-skill-id']);
    expect(result.data.warnings.join('\n')).toMatch(/unknown-skill-id/);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('skills resolved in deterministic order sorted by ID', () => {
    const runDir = tmpRunDir();

    const result = writeSelectedSkills(runDir, parsedSections('- z-skill\n- a-skill'), catalog(runDir));

    expect(result.data.selected_skills.map((skill) => skill.id)).toEqual(['a-skill', 'z-skill']);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('skill with matching catalog entry includes title, source, scope, path', () => {
    const runDir = tmpRunDir();

    const result = writeSelectedSkills(runDir, parsedSections('- a-skill'), catalog(runDir));

    expect(result.data.selected_skills[0]).toEqual({
      id: 'a-skill',
      title: 'A Skill',
      source: 'project',
      scope: 'project',
      path: path.join(runDir, 'source-skills', 'a-skill'),
    });
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('selected_skills.json is stable for same input', () => {
    const runDir = tmpRunDir();
    const sections = parsedSections('- z-skill\n- a-skill\n- unknown-skill-id');

    const first = writeSelectedSkills(runDir, sections, catalog(runDir));
    const firstContent = fs.readFileSync(first.path, 'utf8');
    const second = writeSelectedSkills(runDir, sections, catalog(runDir));
    const secondContent = fs.readFileSync(second.path, 'utf8');

    expect(secondContent).toBe(firstContent);
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
