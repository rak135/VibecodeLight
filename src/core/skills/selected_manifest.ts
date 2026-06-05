import fs from 'fs';
import path from 'path';

import { getProjectSkillsRoot } from './skill_store.js';
import { parseSkillMetadata } from './validators.js';

export const SAFE_SKILL_ID_RE = /^[a-zA-Z0-9._-]+$/;

export const MANIFEST_SCHEMA_VERSION = 1;

export interface SelectedSkillsManifestEntry {
  id: string;
  title: string;
  summary: string;
  source_path: string;
}

export interface SelectedSkillsManifest {
  schema_version: number;
  run_id: string;
  skills_dir: string;
  selected_skills: SelectedSkillsManifestEntry[];
}

export interface WriteManifestResult {
  path: string;
  manifest: SelectedSkillsManifest;
  warnings: string[];
}

export class SelectedSkillsManifestError extends Error {
  code: string;
  path?: string;
  details: string[];

  constructor(
    message: string,
    opts: { code: string; path?: string; details?: string[] },
  ) {
    super(message);
    this.name = 'SelectedSkillsManifestError';
    this.code = opts.code;
    this.path = opts.path;
    this.details = opts.details ?? [];
  }
}

export function isSafeSkillId(id: string): boolean {
  return SAFE_SKILL_ID_RE.test(id);
}

export interface ResolvedSkillFile {
  /** Absolute path to the markdown file that is the source of truth. */
  filePath: string;
  /** Repo-relative path used in artifacts. */
  relativePath: string;
}

/**
 * Resolve the source markdown for a skill id. Supports either:
 *   <repoRoot>/SKILLS/<id>.md           (flat)
 *   <repoRoot>/SKILLS/<id>/SKILL.md     (nested, Anthropic skill convention)
 */
export function resolveSkillSourcePath(
  repoRoot: string,
  skillId: string,
): ResolvedSkillFile | null {
  const skillsRoot = getProjectSkillsRoot(repoRoot);
  const flat = path.join(skillsRoot, `${skillId}.md`);
  if (fs.existsSync(flat) && fs.statSync(flat).isFile()) {
    return {
      filePath: flat,
      relativePath: path.posix.join('SKILLS', `${skillId}.md`),
    };
  }
  const nested = path.join(skillsRoot, skillId, 'SKILL.md');
  if (fs.existsSync(nested) && fs.statSync(nested).isFile()) {
    return {
      filePath: nested,
      relativePath: path.posix.join('SKILLS', skillId, 'SKILL.md'),
    };
  }
  return null;
}

export interface DiscoveredSkill {
  id: string;
  title: string;
  summary: string;
  source_path: string;
  filePath: string;
}

/**
 * Discover available skills under <repoRoot>/SKILLS. Returns deterministic
 * sorted list. Skips entries whose ids are not safe filenames.
 */
export function discoverRepoSkills(repoRoot: string): DiscoveredSkill[] {
  const skillsRoot = getProjectSkillsRoot(repoRoot);
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const idToFile = new Map<string, ResolvedSkillFile>();
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) {
      if (!entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      if (!isSafeSkillId(id)) continue;
      const resolved = resolveSkillSourcePath(repoRoot, id);
      if (resolved) idToFile.set(id, resolved);
    } else if (entry.isDirectory()) {
      const id = entry.name;
      if (!isSafeSkillId(id)) continue;
      const resolved = resolveSkillSourcePath(repoRoot, id);
      if (resolved) idToFile.set(id, resolved);
    }
  }

  const result: DiscoveredSkill[] = [];
  for (const [id, resolved] of idToFile.entries()) {
    const meta = readSkillMeta(resolved.filePath, id);
    result.push({
      id,
      title: meta.title,
      summary: meta.summary,
      source_path: resolved.relativePath,
      filePath: resolved.filePath,
    });
  }
  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

function readSkillMeta(filePath: string, fallbackId: string): { title: string; summary: string } {
  // Reuse the existing parser; it expects a directory containing SKILL.md.
  // For flat files we point it at the parent dir.
  const dirname = path.dirname(filePath);
  const basename = path.basename(filePath);
  if (basename.toLowerCase() === 'skill.md') {
    const meta = parseSkillMetadata(dirname, fallbackId);
    return { title: meta.title, summary: meta.summary };
  }
  // Flat case: read directly via parseSkillMetadata-style parsing.
  // To keep code simple we shell to a tiny inline parser.
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
    const fmMatch = text.match(FRONTMATTER_RE);
    let title = fallbackId;
    let summary = '';
    let body = text;
    if (fmMatch) {
      body = text.slice(fmMatch[0].length);
      // Best-effort: look for `title:` and `summary:`/`description:` lines.
      const fm = fmMatch[1];
      const titleLine = fm.match(/^title:\s*(.+)\s*$/m);
      if (titleLine) title = titleLine[1].replace(/^['"]|['"]$/g, '').trim() || title;
      const summaryLine =
        fm.match(/^summary:\s*(.+)\s*$/m) ?? fm.match(/^description:\s*(.+)\s*$/m);
      if (summaryLine) summary = summaryLine[1].replace(/^['"]|['"]$/g, '').trim();
    }
    if (title === fallbackId) {
      for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        const m = line.match(/^#\s+(.+?)\s*$/);
        if (m) { title = m[1]; break; }
      }
    }
    if (!summary) {
      for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        summary = line; break;
      }
    }
    return { title, summary };
  } catch {
    return { title: fallbackId, summary: '' };
  }
}

export interface BuildManifestOptions {
  runId: string;
  repoRoot: string;
  selectedSkillIds: readonly string[];
}

export interface BuildManifestResult {
  manifest: SelectedSkillsManifest;
  warnings: string[];
  unknownIds: string[];
}

export function buildSelectedSkillsManifest(
  opts: BuildManifestOptions,
): BuildManifestResult {
  const warnings: string[] = [];
  const unknownIds: string[] = [];
  const seen = new Set<string>();
  const entries: SelectedSkillsManifestEntry[] = [];

  for (const rawId of opts.selectedSkillIds) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) continue;
    if (!isSafeSkillId(id)) {
      throw new SelectedSkillsManifestError(`unsafe skill id: ${rawId}`, {
        code: 'UNSAFE_SKILL_ID',
        details: [`Skill id must match ${SAFE_SKILL_ID_RE.toString()}.`],
      });
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const resolved = resolveSkillSourcePath(opts.repoRoot, id);
    if (!resolved) {
      unknownIds.push(id);
      throw new SelectedSkillsManifestError(
        `selected skill "${id}" was not found under SKILLS/`,
        {
          code: 'SKILL_NOT_FOUND',
          path: path.join(opts.repoRoot, 'SKILLS', `${id}.md`),
          details: [
            `Expected SKILLS/${id}.md or SKILLS/${id}/SKILL.md under ${opts.repoRoot}.`,
          ],
        },
      );
    }
    const meta = readSkillMeta(resolved.filePath, id);
    entries.push({
      id,
      title: meta.title,
      summary: meta.summary,
      source_path: resolved.relativePath,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  const manifest: SelectedSkillsManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: opts.runId,
    skills_dir: 'SKILLS',
    selected_skills: entries,
  };

  return { manifest, warnings, unknownIds };
}

export function manifestPathFor(runDir: string): string {
  return path.join(runDir, 'skills', 'manifest.json');
}

export function writeSelectedSkillsManifest(
  runDir: string,
  manifest: SelectedSkillsManifest,
): string {
  const outputPath = manifestPathFor(runDir);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return outputPath;
}

export function readSelectedSkillsManifest(
  runDir: string,
): SelectedSkillsManifest | null {
  const p = manifestPathFor(runDir);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<SelectedSkillsManifest>;
    if (
      typeof data.schema_version !== 'number' ||
      typeof data.run_id !== 'string' ||
      !Array.isArray(data.selected_skills)
    ) {
      return null;
    }
    return data as SelectedSkillsManifest;
  } catch {
    return null;
  }
}
