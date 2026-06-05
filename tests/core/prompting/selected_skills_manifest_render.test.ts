import fs from 'fs';
import os from 'os';
import path from 'path';

import { renderFinalPrompt } from '../../../src/core/prompting/renderer';
import { writeSelectedSkillsManifest } from '../../../src/core/skills/selected_manifest';

function seedRun(): { runDir: string; runId: string } {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-render-manifest-'));
  const runId = 'run-manifest-render';

  fs.writeFileSync(
    path.join(runDir, 'user_prompt.md'),
    'Implement the foo bar widget.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify(
      { run_id: runId, created_at: '2026-06-04T00:00:00Z', task: 'task', status: 'done' },
      null,
      2,
    ),
    'utf8',
  );
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'output', 'context_pack.md'),
    '# Task Summary\nTask summary body.\n',
    'utf8',
  );
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  return { runDir, runId };
}

describe('renderFinalPrompt with selected-skills manifest', () => {
  test('section appears when manifest contains selected skills and never embeds body', () => {
    const { runDir, runId } = seedRun();
    writeSelectedSkillsManifest(runDir, {
      schema_version: 1,
      run_id: runId,
      skills_dir: 'SKILLS',
      selected_skills: [
        {
          id: 'systematic-debugging',
          title: 'Systematic Debugging',
          summary: 'Evidence-based root-cause debugging before proposing fixes.',
          source_path: 'SKILLS/systematic-debugging/SKILL.md',
        },
      ],
    });

    const result = renderFinalPrompt(runDir);
    expect(result.ok).toBe(true);
    const final = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');

    expect(final).toContain('# Selected Skills');
    expect(final).toContain('- systematic-debugging');
    expect(final).toContain('Evidence-based root-cause debugging');
    expect(final).toContain(`vibecode skills show systematic-debugging --run-id ${runId}`);
    expect(final).not.toContain('## systematic-debugging');
    expect(final).not.toContain('Iron Law');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('section is omitted when manifest has no selected skills', () => {
    const { runDir, runId } = seedRun();
    writeSelectedSkillsManifest(runDir, {
      schema_version: 1,
      run_id: runId,
      skills_dir: 'SKILLS',
      selected_skills: [],
    });

    const result = renderFinalPrompt(runDir);
    expect(result.ok).toBe(true);
    const final = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');

    expect(final).not.toContain('# Selected Skills');

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
