import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildSelectedSkillsManifest,
  discoverRepoSkills,
  isSafeSkillId,
  manifestPathFor,
  readSelectedSkillsManifest,
  resolveSkillSourcePath,
  SelectedSkillsManifestError,
  writeSelectedSkillsManifest,
} from '../../../src/core/skills/selected_manifest';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-skill-manifest-'));
}

function seedNestedSkill(repoRoot: string, id: string, body: string): string {
  const dir = path.join(repoRoot, 'SKILLS', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function seedFlatSkill(repoRoot: string, id: string, body: string): string {
  const file = path.join(repoRoot, 'SKILLS', `${id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('selected skills manifest', () => {
  test('isSafeSkillId accepts safe ids and rejects unsafe ones', () => {
    expect(isSafeSkillId('systematic-debugging')).toBe(true);
    expect(isSafeSkillId('skill_v1.2')).toBe(true);
    expect(isSafeSkillId('../escape')).toBe(false);
    expect(isSafeSkillId('skill/sub')).toBe(false);
    expect(isSafeSkillId('skill with space')).toBe(false);
  });

  test('discoverRepoSkills discovers nested and flat skills from SKILLS/', () => {
    const repoRoot = tmpRepo();
    seedNestedSkill(repoRoot, 'nested-skill', '# Nested Title\nfirst paragraph nested.\n');
    seedFlatSkill(repoRoot, 'flat-skill', '---\ntitle: Flat Title\nsummary: flat one-liner\n---\nbody\n');

    const skills = discoverRepoSkills(repoRoot);
    const ids = skills.map((s) => s.id);
    expect(ids).toContain('nested-skill');
    expect(ids).toContain('flat-skill');

    const nested = skills.find((s) => s.id === 'nested-skill')!;
    expect(nested.title).toBe('Nested Title');
    expect(nested.source_path).toBe('SKILLS/nested-skill/SKILL.md');

    const flat = skills.find((s) => s.id === 'flat-skill')!;
    expect(flat.title).toBe('Flat Title');
    expect(flat.summary).toBe('flat one-liner');
    expect(flat.source_path).toBe('SKILLS/flat-skill.md');

    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('discoverRepoSkills handles a missing SKILLS directory gracefully', () => {
    const repoRoot = tmpRepo();
    expect(discoverRepoSkills(repoRoot)).toEqual([]);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('resolveSkillSourcePath prefers flat file when both exist', () => {
    const repoRoot = tmpRepo();
    seedFlatSkill(repoRoot, 'dup', '# Flat\n');
    seedNestedSkill(repoRoot, 'dup', '# Nested\n');
    const resolved = resolveSkillSourcePath(repoRoot, 'dup');
    expect(resolved?.relativePath).toBe('SKILLS/dup.md');
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('buildSelectedSkillsManifest writes only selected skills, deterministic order', () => {
    const repoRoot = tmpRepo();
    seedNestedSkill(repoRoot, 'a-skill', '# A\nA summary\n');
    seedNestedSkill(repoRoot, 'b-skill', '# B\nB summary\n');
    seedNestedSkill(repoRoot, 'c-skill', '# C\nC summary\n');

    const { manifest, unknownIds, warnings } = buildSelectedSkillsManifest({
      runId: 'run-1',
      repoRoot,
      selectedSkillIds: ['c-skill', 'a-skill'],
    });

    expect(unknownIds).toEqual([]);
    expect(warnings).toEqual([]);
    expect(manifest.selected_skills.map((s) => s.id)).toEqual(['a-skill', 'c-skill']);
    expect(manifest.selected_skills.find((s) => s.id === 'b-skill')).toBeUndefined();
    for (const skill of manifest.selected_skills) {
      expect(skill.source_path.startsWith('SKILLS/')).toBe(true);
    }
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('buildSelectedSkillsManifest rejects unsafe ids', () => {
    const repoRoot = tmpRepo();
    expect(() =>
      buildSelectedSkillsManifest({
        runId: 'run-1',
        repoRoot,
        selectedSkillIds: ['../etc/passwd'],
      }),
    ).toThrow(SelectedSkillsManifestError);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('buildSelectedSkillsManifest throws SKILL_NOT_FOUND for unknown ids', () => {
    const repoRoot = tmpRepo();
    seedNestedSkill(repoRoot, 'known', '# Known\nknown summary\n');
    let thrown: SelectedSkillsManifestError | null = null;
    try {
      buildSelectedSkillsManifest({
        runId: 'run-2',
        repoRoot,
        selectedSkillIds: ['known', 'unknown'],
      });
    } catch (err) {
      thrown = err as SelectedSkillsManifestError;
    }
    expect(thrown).toBeInstanceOf(SelectedSkillsManifestError);
    expect(thrown?.code).toBe('SKILL_NOT_FOUND');
    expect(thrown?.message).toMatch(/unknown/);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('writeSelectedSkillsManifest writes manifest.json with schema_version, no skill body content', () => {
    const repoRoot = tmpRepo();
    seedNestedSkill(repoRoot, 'one', '# One\nshort summary line\n\nbody-line-NEVER-EMBEDDED\n');
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-skill-manifest-run-'));
    const { manifest } = buildSelectedSkillsManifest({
      runId: 'run-x',
      repoRoot,
      selectedSkillIds: ['one'],
    });
    const out = writeSelectedSkillsManifest(runDir, manifest);
    expect(out).toBe(manifestPathFor(runDir));
    const raw = fs.readFileSync(out, 'utf8');
    expect(raw).not.toContain('body-line-NEVER-EMBEDDED');
    const reread = readSelectedSkillsManifest(runDir);
    expect(reread?.schema_version).toBe(1);
    expect(reread?.run_id).toBe('run-x');
    expect(reread?.selected_skills.map((s) => s.id)).toEqual(['one']);

    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
