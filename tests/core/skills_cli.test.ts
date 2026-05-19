import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';

const repoRoot = path.resolve(__dirname, '../..');

function runCli(args: string[], cwd: string, env?: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'vibecode.js'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...(env ?? {}) },
  });
}

function makeTempRepo(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vibecode-skills-cli-${label}-`));
}

function writeSkillFile(baseDir: string, scope: string, id: string, body: string): void {
  const dir = path.join(baseDir, scope, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
}

const FIXTURE_SKILL = `---
name: fixture-skill
description: Skill used for CLI smoke tests
metadata:
  hermes:
    tags: [fixture]
---

# Fixture Skill

Body.
`;

describe('skills list CLI', () => {
  test('vibecode skills list --json returns canonical envelope', () => {
    const tmp = makeTempRepo('list');
    const profile = path.join(tmp, 'profile');
    const userSkills = path.join(profile, 'skills');
    writeSkillFile(userSkills, 'default', 'sample-default', FIXTURE_SKILL);
    writeSkillFile(userSkills, 'user', 'sample-user', FIXTURE_SKILL);
    fs.mkdirSync(path.join(tmp, 'SKILLS', 'proj-one'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'SKILLS', 'proj-one', 'SKILL.md'), FIXTURE_SKILL, 'utf8');

    const result = runCli(['skills', 'list', '--json', '--repo', tmp], tmp, {
      VIBECODE_USER_PROFILE: profile,
    });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload).toHaveProperty('ok', true);
    expect(payload).toHaveProperty('data');
    expect(payload).toHaveProperty('artifacts');
    expect(payload).toHaveProperty('warnings');
    expect(Array.isArray(payload.data.skills)).toBe(true);

    const ids = payload.data.skills.map((s: { id: string }) => s.id).sort();
    expect(ids).toContain('sample-default');
    expect(ids).toContain('sample-user');
    expect(ids).toContain('proj-one');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('vibecode skills list (human) exits 0 and lists user-profile skills', () => {
    const tmp = makeTempRepo('list-h');
    const profile = path.join(tmp, 'profile');
    const userSkills = path.join(profile, 'skills');
    writeSkillFile(userSkills, 'default', 'human-skill', FIXTURE_SKILL);

    const result = runCli(['skills', 'list', '--repo', tmp], tmp, {
      VIBECODE_USER_PROFILE: profile,
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('human-skill');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('skills project-list CLI', () => {
  test('project-list --json returns only project SKILLS/ entries', () => {
    const tmp = makeTempRepo('plist');
    const profile = path.join(tmp, 'profile');
    const userSkills = path.join(profile, 'skills');
    writeSkillFile(userSkills, 'default', 'profile-only', FIXTURE_SKILL);
    fs.mkdirSync(path.join(tmp, 'SKILLS', 'proj-x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'SKILLS', 'proj-x', 'SKILL.md'), FIXTURE_SKILL, 'utf8');

    const result = runCli(['skills', 'project-list', '--json', '--repo', tmp], tmp, {
      VIBECODE_USER_PROFILE: profile,
    });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    const ids = payload.data.skills.map((s: { id: string }) => s.id);
    expect(ids).toEqual(['proj-x']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('skills copy CLI', () => {
  test('copy <id> places skill into project SKILLS/', () => {
    const tmp = makeTempRepo('copy');
    const profile = path.join(tmp, 'profile');
    const userSkills = path.join(profile, 'skills');
    writeSkillFile(userSkills, 'default', 'copy-me', FIXTURE_SKILL);

    const result = runCli(['skills', 'copy', 'copy-me', '--repo', tmp], tmp, {
      VIBECODE_USER_PROFILE: profile,
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'SKILLS', 'copy-me', 'SKILL.md'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('copy refuses to overwrite without --force and returns non-zero', () => {
    const tmp = makeTempRepo('copy-refuse');
    const profile = path.join(tmp, 'profile');
    const userSkills = path.join(profile, 'skills');
    writeSkillFile(userSkills, 'default', 'dup', FIXTURE_SKILL);
    fs.mkdirSync(path.join(tmp, 'SKILLS', 'dup'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'SKILLS', 'dup', 'SKILL.md'), 'existing\n', 'utf8');

    const result = runCli(['skills', 'copy', 'dup', '--json', '--repo', tmp], tmp, {
      VIBECODE_USER_PROFILE: profile,
    });
    expect(result.status).not.toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('DEST_EXISTS');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('copy --all copies all user-profile skills', () => {
    const tmp = makeTempRepo('copy-all');
    const profile = path.join(tmp, 'profile');
    const userSkills = path.join(profile, 'skills');
    writeSkillFile(userSkills, 'default', 'a', FIXTURE_SKILL);
    writeSkillFile(userSkills, 'user', 'b', FIXTURE_SKILL);

    const result = runCli(['skills', 'copy', '--all', '--repo', tmp], tmp, {
      VIBECODE_USER_PROFILE: profile,
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'SKILLS', 'a', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'SKILLS', 'b', 'SKILL.md'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('scan writes per-run skills_catalog.json', () => {
  test('scan run contains .vibecode/runs/<id>/skills/skills_catalog.json with project skills', () => {
    const tmp = makeTempRepo('scan-cat');
    const vibecodePath = path.join(tmp, '.vibecode');
    fs.mkdirSync(path.join(vibecodePath, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(vibecodePath, 'current'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'hello.py'), 'print(1)\n', 'utf8');
    fs.mkdirSync(path.join(tmp, 'SKILLS', 'cat-skill'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'SKILLS', 'cat-skill', 'SKILL.md'), FIXTURE_SKILL, 'utf8');

    const result = runCli(['scan', 'skills cat test', '--json'], tmp, {
      VIBECODE_USER_PROFILE: path.join(tmp, 'empty-profile'),
    });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    const runId = payload.data.run_id as string;
    const catalogPath = path.join(vibecodePath, 'runs', runId, 'skills', 'skills_catalog.json');
    expect(fs.existsSync(catalogPath)).toBe(true);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    expect(Array.isArray(catalog.skills)).toBe(true);
    const ids = catalog.skills.map((s: { id: string }) => s.id);
    expect(ids).toContain('cat-skill');

    // Python scanner output should not contain canonical skills_catalog.json under scan/
    const scanDir = path.join(vibecodePath, 'runs', runId, 'scan');
    expect(fs.existsSync(path.join(scanDir, 'skills_catalog.json'))).toBe(false);

    // .vibecode/ never contains source skills folder
    expect(fs.existsSync(path.join(vibecodePath, 'SKILLS'))).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
