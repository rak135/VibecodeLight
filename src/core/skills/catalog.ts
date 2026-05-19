import fs from 'fs';
import path from 'path';

import {
  SkillMetadata,
  SkillScope,
  SkillsCatalog,
} from '../models/index.js';
import {
  getProjectSkillsRoot,
  listSkillDirs,
  resolveUserSkillsRoot,
} from './skill_store.js';
import { parseSkillMetadata } from './validators.js';

const USER_PROFILE_SCOPES: SkillScope[] = ['default', 'user'];

// Deterministic precedence when the same id appears in multiple sources.
// Higher rank wins.
const SCOPE_RANK: Record<SkillScope, number> = {
  default: 1,
  user: 2,
  project: 3,
};

export function discoverUserProfileSkills(skillsRoot: string): SkillMetadata[] {
  const result: SkillMetadata[] = [];
  for (const scope of USER_PROFILE_SCOPES) {
    const scopeDir = path.join(skillsRoot, scope);
    for (const id of listSkillDirs(scopeDir)) {
      const skillDir = path.join(scopeDir, id);
      result.push(parseSkillMetadata(skillDir, id, { source: 'user-profile', scope }));
    }
  }
  return result;
}

export function discoverProjectSkills(repoRoot: string): SkillMetadata[] {
  const projectRoot = getProjectSkillsRoot(repoRoot);
  return listSkillDirs(projectRoot).map((id) =>
    parseSkillMetadata(path.join(projectRoot, id), id, {
      source: 'project',
      scope: 'project',
    }),
  );
}

export interface BuildCatalogOptions {
  repoRoot: string;
  userSkillsRoot?: string;
}

export function buildSkillsCatalog(opts: BuildCatalogOptions): SkillsCatalog {
  const userRoot = resolveUserSkillsRoot(opts.userSkillsRoot);
  const user = discoverUserProfileSkills(userRoot);
  const project = discoverProjectSkills(opts.repoRoot);

  const warnings: string[] = [];
  const byId = new Map<string, SkillMetadata>();
  const duplicates = new Set<string>();

  for (const entry of [...user, ...project]) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    duplicates.add(entry.id);
    if (SCOPE_RANK[entry.scope] >= SCOPE_RANK[existing.scope]) {
      byId.set(entry.id, entry);
    }
  }

  for (const id of duplicates) {
    const winner = byId.get(id);
    warnings.push(
      `duplicate skill id "${id}" found in multiple sources; using ${winner?.source ?? 'unknown'}/${winner?.scope ?? 'unknown'}`,
    );
  }

  const skills = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of skills) {
    for (const warning of skill.warnings) {
      warnings.push(`${skill.id}: ${warning}`);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    skills,
    warnings,
  };
}

export function writeSkillsCatalog(catalogPath: string, catalog: SkillsCatalog): void {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}
