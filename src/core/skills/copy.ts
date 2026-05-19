import fs from 'fs';
import path from 'path';

import { discoverUserProfileSkills } from './catalog.js';
import {
  getProjectSkillsRoot,
  resolveUserSkillsRoot,
} from './skill_store.js';

export interface CopyError {
  code: string;
  message: string;
  path?: string;
}

export interface CopyResult {
  ok: boolean;
  skillId: string;
  destination?: string;
  error?: CopyError;
}

export interface CopySkillOptions {
  skillId: string;
  repoRoot: string;
  userSkillsRoot?: string;
  force?: boolean;
}

function copyTree(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

export function copySkill(opts: CopySkillOptions): CopyResult {
  const userRoot = resolveUserSkillsRoot(opts.userSkillsRoot);
  const skills = discoverUserProfileSkills(userRoot);
  const source = skills.find((s) => s.id === opts.skillId);
  if (!source) {
    return {
      ok: false,
      skillId: opts.skillId,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `skill "${opts.skillId}" was not found in user-profile skills`,
      },
    };
  }

  const destination = path.join(getProjectSkillsRoot(opts.repoRoot), opts.skillId);
  const destExists = fs.existsSync(destination);
  if (destExists && !opts.force) {
    return {
      ok: false,
      skillId: opts.skillId,
      destination,
      error: {
        code: 'DEST_EXISTS',
        message: `destination already exists; pass --force to overwrite`,
        path: destination,
      },
    };
  }

  if (destExists && opts.force) {
    fs.rmSync(destination, { recursive: true, force: true });
  }

  try {
    copyTree(source.path, destination);
  } catch (err) {
    return {
      ok: false,
      skillId: opts.skillId,
      destination,
      error: {
        code: 'COPY_FAILED',
        message: (err as Error).message,
        path: destination,
      },
    };
  }

  return { ok: true, skillId: opts.skillId, destination };
}

export interface CopyAllOptions {
  repoRoot: string;
  userSkillsRoot?: string;
  force?: boolean;
}

export interface CopyAllResult {
  copied: string[];
  skipped: string[];
  errors: { skillId: string; error: CopyError }[];
}

export function copyAllSkills(opts: CopyAllOptions): CopyAllResult {
  const userRoot = resolveUserSkillsRoot(opts.userSkillsRoot);
  const skills = discoverUserProfileSkills(userRoot);
  const copied: string[] = [];
  const skipped: string[] = [];
  const errors: { skillId: string; error: CopyError }[] = [];

  for (const skill of skills) {
    const result = copySkill({
      skillId: skill.id,
      repoRoot: opts.repoRoot,
      userSkillsRoot: opts.userSkillsRoot,
      force: opts.force,
    });
    if (result.ok) {
      copied.push(skill.id);
    } else if (result.error?.code === 'DEST_EXISTS') {
      skipped.push(skill.id);
    } else if (result.error) {
      errors.push({ skillId: skill.id, error: result.error });
    }
  }

  return { copied, skipped, errors };
}
