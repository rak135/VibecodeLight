import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ContextFinalizeError,
  finalizeContext,
} from '../../../src/core/context/context_finalize';

function flashOutput(selectedSkillsBlock = '- alpha'): string {
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
    selectedSkillsBlock,
    '',
    '# Cautions',
    '- Be careful.',
    '',
    '# Context Pack',
    'Finalized context body.',
    '',
  ].join('\n');
}

function seedRepoWithRun(): { repoRoot: string; runDir: string; skillDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-finalize-skills-'));
  const runId = '20260101-000000-finalize-skills';
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  const skillDir = path.join(repoRoot, 'SKILLS', 'alpha');
  fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\ntitle: Alpha\nsummary: Alpha one-liner\n---\nAlpha instructions body.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    `${JSON.stringify({ run_id: runId, created_at: '2026-01-01T00:00:00.000Z', task: 'x', status: 'done' }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'skills', 'skills_catalog.json'),
    `${JSON.stringify(
      {
        generated_at: '2026-01-01T00:00:00.000Z',
        warnings: [],
        skills: [
          {
            id: 'alpha',
            title: 'Alpha',
            summary: 'Alpha summary',
            tags: [],
            source: 'project',
            scope: 'project',
            path: skillDir,
            has_skill_md: true,
            has_skill_yaml: false,
            warnings: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(runDir, 'flash', 'flash_output.md'), flashOutput(), 'utf8');
  return { repoRoot, runDir, skillDir };
}

describe('finalizeContext with selectedSkillIds', () => {
  test('selectedSkillIds skips legacy selected_skill_contents.md', () => {
    const { repoRoot, runDir } = seedRepoWithRun();

    const result = finalizeContext(runDir, {
      selectedSkillIds: ['alpha'],
      repoRoot,
    });

    const manifestPath = path.join(runDir, 'skills', 'manifest.json');
    const legacyPath = path.join(runDir, 'skills', 'selected_skill_contents.md');

    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(result.artifacts).not.toContain(legacyPath);
    expect(result.artifacts).toContain(manifestPath);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      selected_skills: Array<{ id: string; summary: string }>;
    };
    expect(manifest.selected_skills.map((s) => s.id)).toEqual(['alpha']);
    // The manifest stores only metadata, not the full skill body.
    expect(fs.readFileSync(manifestPath, 'utf8')).not.toContain('Alpha instructions body');

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('no selectedSkillIds keeps the legacy artifact for backward compatibility', () => {
    const { repoRoot, runDir } = seedRepoWithRun();

    const result = finalizeContext(runDir);

    const legacyPath = path.join(runDir, 'skills', 'selected_skill_contents.md');
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(result.artifacts).toContain(legacyPath);

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('unknown selectedSkillId throws ContextFinalizeError(SKILL_NOT_FOUND) and writes no manifest', () => {
    const { repoRoot, runDir } = seedRepoWithRun();

    let thrown: ContextFinalizeError | null = null;
    try {
      finalizeContext(runDir, {
        selectedSkillIds: ['definitely-not-a-real-skill'],
        repoRoot,
      });
    } catch (err) {
      thrown = err as ContextFinalizeError;
    }

    expect(thrown).toBeInstanceOf(ContextFinalizeError);
    expect(thrown?.code).toBe('SKILL_NOT_FOUND');

    const manifestPath = path.join(runDir, 'skills', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(false);

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
});
