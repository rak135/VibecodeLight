import fs from 'fs';
import os from 'os';
import path from 'path';

import { finalizeContext, ContextFinalizeError } from '../../../src/core/context/context_finalize';
import { renderFinalPrompt } from '../../../src/core/prompting/renderer';
import { REQUIRED_SECTIONS } from '../../../src/core/context/flash_output_contract';

/**
 * Behavior contract for the manual-only selected-skills MVP:
 *
 *   - selectedSkillIds is the only source of selected skills.
 *   - Flash output's # Selected Skills section must not influence the run.
 *   - Flash output must not produce skill warnings or write selected_skill_contents.md.
 *   - The renderer's # Selected Skills section is driven only by skills/manifest.json.
 */

function flashOutputWithSelectedSkills(selectedSkillsBlock: string): string {
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

function seedRepoWithRun(opts: { flashSelectedSkills?: string } = {}): {
  repoRoot: string;
  runDir: string;
  skillDir: string;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-skills-disabled-'));
  const runId = '20260101-000000-flash-disabled';
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  const skillDir = path.join(repoRoot, 'SKILLS', 'systematic-debugging');
  fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\ntitle: Systematic Debugging\nsummary: Root-cause investigation.\n---\n# Systematic Debugging\n\nDebug body here.\n',
    'utf8',
  );

  fs.writeFileSync(
    path.join(runDir, 'user_prompt.md'),
    'Task: drive a feature.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    `${JSON.stringify({
      run_id: runId,
      created_at: '2026-01-01T00:00:00.000Z',
      task: 'drive a feature',
      status: 'done',
    }, null, 2)}\n`,
    'utf8',
  );
  // Empty catalog is fine for the new manual-only flow.
  fs.writeFileSync(
    path.join(runDir, 'skills', 'skills_catalog.json'),
    `${JSON.stringify(
      { generated_at: '2026-01-01T00:00:00.000Z', warnings: [], skills: [] },
      null,
      2,
    )}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'flash', 'flash_output.md'),
    flashOutputWithSelectedSkills(opts.flashSelectedSkills ?? ''),
    'utf8',
  );
  return { repoRoot, runDir, skillDir };
}

describe('flash-driven skill selection is disabled', () => {
  test('flash output with selected_skills is ignored: no warnings, no selected_skill_contents.md', () => {
    const { repoRoot, runDir } = seedRepoWithRun({
      flashSelectedSkills: [
        '- Context Management',
        '- Prompt Engineering / Display',
        '- UI Modification (Desktop)',
      ].join('\n'),
    });

    const result = finalizeContext(runDir);

    expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skill_contents.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skills.json'))).toBe(false);

    for (const warning of result.warnings) {
      expect(warning).not.toMatch(/was not found in skills_catalog\.json/);
      expect(warning).not.toMatch(/Context Management/);
      expect(warning).not.toMatch(/Prompt Engineering/);
      expect(warning).not.toMatch(/UI Modification/);
    }
    expect(result.missing_skills).toEqual([]);

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('no manual skills: no # Selected Skills section in final_prompt.md', () => {
    const { repoRoot, runDir } = seedRepoWithRun({
      flashSelectedSkills: '- ignored-by-design',
    });

    finalizeContext(runDir);
    const render = renderFinalPrompt(runDir);
    expect(render.ok).toBe(true);

    const finalPrompt = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(finalPrompt).not.toMatch(/^# Selected Skills$/m);
    expect(finalPrompt).not.toMatch(/no selected skills/i);

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('manual --skill yields manifest, # Selected Skills section, load command, no body', () => {
    const { repoRoot, runDir } = seedRepoWithRun();

    const result = finalizeContext(runDir, {
      selectedSkillIds: ['systematic-debugging'],
      repoRoot,
    });

    const manifestPath = path.join(runDir, 'skills', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skill_contents.md'))).toBe(false);
    expect(result.artifacts).toContain(manifestPath);

    const render = renderFinalPrompt(runDir);
    expect(render.ok).toBe(true);

    const finalPrompt = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(finalPrompt).toMatch(/^# Selected Skills$/m);
    expect(finalPrompt).toContain('- systematic-debugging');
    expect(finalPrompt).toContain('vibecode skills show systematic-debugging --run-id');
    expect(finalPrompt).not.toContain('Debug body here.');

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('manual unknown skill fails with SKILL_NOT_FOUND from selectedSkillIds, not from flash', () => {
    const { repoRoot, runDir } = seedRepoWithRun();

    let thrown: ContextFinalizeError | undefined;
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
    expect(fs.existsSync(path.join(runDir, 'skills', 'manifest.json'))).toBe(false);

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('flash system prompt does not ask the model to choose / select skills', () => {
    const promptPath = path.resolve(__dirname, '../../../resources/prompts/flash_system.md');
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).toMatch(/Selected Skills/);
    expect(prompt).toMatch(/leave the Selected Skills section empty/i);
    expect(prompt).toMatch(/do not.*(infer|propose|list).*skills/i);
    expect(prompt).not.toMatch(/relevant skills/i);
  });

  test('flash output contract still requires the Selected Skills section header for parser compatibility', () => {
    // Compatibility: parsing keeps accepting selected_skills, but it is ignored
    // and does not feed selectedSkillIds.
    expect(REQUIRED_SECTIONS).toContain('Selected Skills');
  });
});
