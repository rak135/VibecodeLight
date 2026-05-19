import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildSkillsCatalog,
  discoverProjectSkills,
  discoverUserProfileSkills,
} from '../../src/core/skills/catalog';
import { copySkill, copyAllSkills } from '../../src/core/skills/copy';
import { parseSkillMetadata } from '../../src/core/skills/validators';

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vibecode-skills-${label}-`));
}

function writeSkill(
  baseDir: string,
  id: string,
  opts: {
    skillMd?: string;
    skillYaml?: string;
  },
): string {
  const dir = path.join(baseDir, id);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.skillMd !== undefined) {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), opts.skillMd, 'utf8');
  }
  if (opts.skillYaml !== undefined) {
    fs.writeFileSync(path.join(dir, 'skill.yaml'), opts.skillYaml, 'utf8');
  }
  return dir;
}

const SAMPLE_SKILL_MD = `---
name: sample-skill
description: A sample skill for tests
version: 1.0.0
metadata:
  hermes:
    tags: [testing, sample]
---

# Sample Skill

Body text.
`;

const SAMPLE_SKILL_NO_FM = `# Plain Title\n\nBody text without frontmatter.\n`;

describe('skill validators', () => {
  test('parseSkillMetadata extracts id/title/summary/tags from SKILL.md frontmatter', () => {
    const dir = tempDir('vd');
    const skillDir = writeSkill(dir, 'sample-skill', { skillMd: SAMPLE_SKILL_MD });
    const meta = parseSkillMetadata(skillDir, 'sample-skill');
    expect(meta.id).toBe('sample-skill');
    expect(meta.title).toBeTruthy();
    expect(meta.summary).toContain('sample skill');
    expect(meta.tags).toEqual(expect.arrayContaining(['testing', 'sample']));
    expect(meta.has_skill_md).toBe(true);
    expect(meta.has_skill_yaml).toBe(false);
    expect(meta.warnings).toEqual([]);
  });

  test('parseSkillMetadata derives metadata from SKILL.md heading when frontmatter is absent', () => {
    const dir = tempDir('vd');
    const skillDir = writeSkill(dir, 'plain-skill', { skillMd: SAMPLE_SKILL_NO_FM });
    const meta = parseSkillMetadata(skillDir, 'plain-skill');
    expect(meta.id).toBe('plain-skill');
    expect(meta.title).toBe('Plain Title');
    expect(meta.has_skill_md).toBe(true);
    expect(meta.has_skill_yaml).toBe(false);
  });

  test('parseSkillMetadata parses separate skill.yaml when present', () => {
    const dir = tempDir('vd');
    const skillDir = writeSkill(dir, 'yaml-skill', {
      skillMd: '# Yaml Skill\n',
      skillYaml: 'name: yaml-skill\ndescription: From yaml file\ntags:\n  - alpha\n  - beta\n',
    });
    const meta = parseSkillMetadata(skillDir, 'yaml-skill');
    expect(meta.summary).toContain('From yaml');
    expect(meta.tags).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(meta.has_skill_yaml).toBe(true);
  });

  test('parseSkillMetadata returns a warning when SKILL.md is missing and does not crash', () => {
    const dir = tempDir('vd');
    const skillDir = path.join(dir, 'broken-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const meta = parseSkillMetadata(skillDir, 'broken-skill');
    expect(meta.has_skill_md).toBe(false);
    expect(meta.warnings.length).toBeGreaterThan(0);
    expect(meta.warnings.join(' ')).toMatch(/SKILL\.md/);
  });
});

describe('skills discovery', () => {
  test('discoverUserProfileSkills returns default/ and user/ skills', () => {
    const profile = tempDir('profile');
    const skillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(skillsRoot, 'default'), 'def-one', { skillMd: SAMPLE_SKILL_MD });
    writeSkill(path.join(skillsRoot, 'user'), 'user-one', { skillMd: SAMPLE_SKILL_MD });

    const skills = discoverUserProfileSkills(skillsRoot);
    const ids = skills.map((s) => `${s.scope}:${s.id}`).sort();
    expect(ids).toContain('default:def-one');
    expect(ids).toContain('user:user-one');
    skills.forEach((s) => {
      expect(s.source).toBe('user-profile');
    });
  });

  test('discoverUserProfileSkills handles missing root gracefully', () => {
    const profile = tempDir('profile-empty');
    const skills = discoverUserProfileSkills(path.join(profile, 'skills'));
    expect(skills).toEqual([]);
  });

  test('discoverProjectSkills returns project SKILLS/ entries', () => {
    const repo = tempDir('repo');
    const skillsRoot = path.join(repo, 'SKILLS');
    writeSkill(skillsRoot, 'proj-skill', { skillMd: SAMPLE_SKILL_MD });

    const skills = discoverProjectSkills(repo);
    expect(skills.length).toBe(1);
    expect(skills[0].id).toBe('proj-skill');
    expect(skills[0].source).toBe('project');
    expect(skills[0].scope).toBe('project');
  });
});

describe('skills catalog', () => {
  test('buildSkillsCatalog includes user-profile and project skills', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(userSkillsRoot, 'default'), 'def-skill', { skillMd: SAMPLE_SKILL_MD });
    writeSkill(path.join(repo, 'SKILLS'), 'proj-skill', { skillMd: SAMPLE_SKILL_MD });

    const catalog = buildSkillsCatalog({ repoRoot: repo, userSkillsRoot });
    const ids = catalog.skills.map((s) => s.id);
    expect(ids).toContain('def-skill');
    expect(ids).toContain('proj-skill');
  });

  test('buildSkillsCatalog deterministically resolves duplicate IDs (project wins) and warns', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(userSkillsRoot, 'default'), 'dup', { skillMd: SAMPLE_SKILL_MD });
    writeSkill(path.join(userSkillsRoot, 'user'), 'dup', { skillMd: SAMPLE_SKILL_MD });
    writeSkill(path.join(repo, 'SKILLS'), 'dup', { skillMd: SAMPLE_SKILL_MD });

    const catalog = buildSkillsCatalog({ repoRoot: repo, userSkillsRoot });
    const dup = catalog.skills.find((s) => s.id === 'dup');
    expect(dup).toBeDefined();
    expect(dup?.source).toBe('project');
    expect(catalog.warnings.some((w) => w.includes('dup'))).toBe(true);
  });

  test('buildSkillsCatalog tolerates missing user profile or project SKILLS dir', () => {
    const repo = tempDir('repo-only');
    const catalog = buildSkillsCatalog({ repoRoot: repo, userSkillsRoot: '/no/such/path' });
    expect(catalog.skills).toEqual([]);
    expect(Array.isArray(catalog.warnings)).toBe(true);
  });
});

describe('skills copy', () => {
  test('copySkill copies a user-profile skill into project SKILLS/<id>/', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(userSkillsRoot, 'default'), 'tdd', { skillMd: SAMPLE_SKILL_MD });

    const result = copySkill({ skillId: 'tdd', repoRoot: repo, userSkillsRoot });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, 'SKILLS', 'tdd', 'SKILL.md'))).toBe(true);
  });

  test('copySkill refuses to overwrite existing destination without force', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(userSkillsRoot, 'default'), 'tdd', { skillMd: SAMPLE_SKILL_MD });
    fs.mkdirSync(path.join(repo, 'SKILLS', 'tdd'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'SKILLS', 'tdd', 'SKILL.md'), 'existing\n', 'utf8');

    const result = copySkill({ skillId: 'tdd', repoRoot: repo, userSkillsRoot });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('DEST_EXISTS');
    // contents untouched
    expect(fs.readFileSync(path.join(repo, 'SKILLS', 'tdd', 'SKILL.md'), 'utf8')).toBe('existing\n');
  });

  test('copySkill --force overwrites existing destination', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(userSkillsRoot, 'default'), 'tdd', { skillMd: SAMPLE_SKILL_MD });
    fs.mkdirSync(path.join(repo, 'SKILLS', 'tdd'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'SKILLS', 'tdd', 'SKILL.md'), 'existing\n', 'utf8');

    const result = copySkill({ skillId: 'tdd', repoRoot: repo, userSkillsRoot, force: true });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'SKILLS', 'tdd', 'SKILL.md'), 'utf8')).toContain(
      'sample-skill',
    );
  });

  test('copySkill returns SKILL_NOT_FOUND for unknown id', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');

    const result = copySkill({ skillId: 'missing', repoRoot: repo, userSkillsRoot });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SKILL_NOT_FOUND');
  });

  test('copyAllSkills copies every user-profile skill into project SKILLS/', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(userSkillsRoot, 'default'), 'tdd', { skillMd: SAMPLE_SKILL_MD });
    writeSkill(path.join(userSkillsRoot, 'user'), 'custom', { skillMd: SAMPLE_SKILL_MD });

    const result = copyAllSkills({ repoRoot: repo, userSkillsRoot });
    expect(result.copied.sort()).toEqual(['custom', 'tdd']);
    expect(fs.existsSync(path.join(repo, 'SKILLS', 'tdd', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'SKILLS', 'custom', 'SKILL.md'))).toBe(true);
  });

  test('copyAllSkills skips entries that already exist without force', () => {
    const profile = tempDir('profile');
    const repo = tempDir('repo');
    const userSkillsRoot = path.join(profile, 'skills');
    writeSkill(path.join(userSkillsRoot, 'default'), 'tdd', { skillMd: SAMPLE_SKILL_MD });
    fs.mkdirSync(path.join(repo, 'SKILLS', 'tdd'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'SKILLS', 'tdd', 'SKILL.md'), 'existing\n', 'utf8');

    const result = copyAllSkills({ repoRoot: repo, userSkillsRoot });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toContain('tdd');
  });
});
