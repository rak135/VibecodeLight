import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeSelectedSkillContents } from '../../../src/core/context/selected_skill_contents';
import type { SelectedSkillsFile } from '../../../src/core/context/selected_skills';

function tmpRunDir(): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-selected-skill-contents-'));
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  return runDir;
}

function writeSkill(runDir: string, id: string, content: string): string {
  const skillDir = path.join(runDir, 'source-skills', id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return skillDir;
}

function selectedSkillsFile(entries: SelectedSkillsFile['selected_skills'], missing: string[] = []): SelectedSkillsFile {
  return {
    run_id: 'run-selected-skill-contents',
    selected_skills: entries,
    warnings: [],
    missing_skills: missing,
  };
}

describe('writeSelectedSkillContents', () => {
  test('selected_skill_contents.md includes heading per skill', () => {
    const runDir = tmpRunDir();
    const skillDir = writeSkill(runDir, 'alpha', '# Alpha\n\nAlpha body.\n');

    const result = writeSelectedSkillContents(runDir, selectedSkillsFile([
      { id: 'alpha', title: 'Alpha', source: 'project', scope: 'project', path: skillDir },
    ]));
    const content = fs.readFileSync(result.path, 'utf8');

    expect(content).toContain('# Selected Skill Contents');
    expect(content).toContain('## alpha');
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('includes skill ID and source path', () => {
    const runDir = tmpRunDir();
    const skillDir = writeSkill(runDir, 'alpha', '# Alpha\n');

    const result = writeSelectedSkillContents(runDir, selectedSkillsFile([
      { id: 'alpha', title: 'Alpha', source: 'project', scope: 'project', path: skillDir },
    ]));
    const content = fs.readFileSync(result.path, 'utf8');

    expect(content).toContain('## alpha');
    expect(content).toContain('**Source:** project');
    expect(content).toContain(`**Path:** ${skillDir}`);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('includes SKILL.md content', () => {
    const runDir = tmpRunDir();
    const skillBody = '# Alpha\n\nUnique skill instructions.\n';
    const skillDir = writeSkill(runDir, 'alpha', skillBody);

    const result = writeSelectedSkillContents(runDir, selectedSkillsFile([
      { id: 'alpha', title: 'Alpha', source: 'project', scope: 'project', path: skillDir },
    ]));
    const content = fs.readFileSync(result.path, 'utf8');

    expect(content).toContain(skillBody);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('missing SKILL.md produces warning block, not fake content', () => {
    const runDir = tmpRunDir();
    const missingDir = path.join(runDir, 'source-skills', 'missing-md');
    fs.mkdirSync(missingDir, { recursive: true });

    const result = writeSelectedSkillContents(runDir, selectedSkillsFile([
      { id: 'missing-md', title: 'Missing', source: 'user-profile', scope: 'user', path: missingDir },
    ], ['unknown-selected-id']));
    const content = fs.readFileSync(result.path, 'utf8');

    expect(result.warnings.join('\n')).toMatch(/SKILL\.md/);
    expect(content).toContain('## missing-md');
    expect(content).toContain('**Warning:**');
    expect(content).toContain(path.join(missingDir, 'SKILL.md'));
    expect(content).not.toContain('No content available');
    expect(content).toContain('## unknown-selected-id');
    expect(content).toContain('Missing skill metadata');
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('deterministic order sorted by skill ID', () => {
    const runDir = tmpRunDir();
    const zDir = writeSkill(runDir, 'zeta', '# Zeta\n');
    const aDir = writeSkill(runDir, 'alpha', '# Alpha\n');

    const result = writeSelectedSkillContents(runDir, selectedSkillsFile([
      { id: 'zeta', title: 'Zeta', source: 'project', scope: 'project', path: zDir },
      { id: 'alpha', title: 'Alpha', source: 'project', scope: 'project', path: aDir },
    ]));
    const content = fs.readFileSync(result.path, 'utf8');

    expect(content.indexOf('## alpha')).toBeLessThan(content.indexOf('## zeta'));
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
