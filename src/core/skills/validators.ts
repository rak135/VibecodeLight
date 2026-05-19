import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { SkillMetadata, SkillSource, SkillScope } from '../models/index.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function extractFrontmatter(text: string): { data: Record<string, unknown> | null; body: string } {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return { data: null, body: text };
  }
  try {
    const parsed = YAML.parse(match[1]) as Record<string, unknown> | null;
    const body = text.slice(match[0].length);
    return { data: parsed && typeof parsed === 'object' ? parsed : null, body };
  } catch {
    return { data: null, body: text.slice(match[0].length) };
  }
}

function firstHeading(body: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) {
      return m[1];
    }
  }
  return null;
}

function firstParagraph(body: string): string | null {
  const lines = body.split(/\r?\n/);
  let inFrontHeading = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inFrontHeading) {
        inFrontHeading = false;
      }
      continue;
    }
    if (line.startsWith('#')) {
      inFrontHeading = true;
      continue;
    }
    return line;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === 'string');
}

function deriveTitle(
  frontmatter: Record<string, unknown> | null,
  body: string,
  fallbackId: string,
): string {
  if (frontmatter && typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }
  const heading = firstHeading(body);
  if (heading) {
    return heading;
  }
  if (frontmatter && typeof frontmatter.name === 'string' && frontmatter.name.trim()) {
    return frontmatter.name.trim();
  }
  return fallbackId;
}

function deriveSummary(
  frontmatter: Record<string, unknown> | null,
  body: string,
): string {
  if (frontmatter) {
    for (const key of ['summary', 'description']) {
      const value = frontmatter[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  const paragraph = firstParagraph(body);
  return paragraph ?? '';
}

function deriveTags(frontmatter: Record<string, unknown> | null): string[] {
  if (!frontmatter) {
    return [];
  }
  const direct = asStringArray(frontmatter.tags);
  if (direct.length > 0) {
    return direct;
  }
  const metadata = frontmatter.metadata;
  if (metadata && typeof metadata === 'object') {
    const hermes = (metadata as Record<string, unknown>).hermes;
    if (hermes && typeof hermes === 'object') {
      const hermesTags = asStringArray((hermes as Record<string, unknown>).tags);
      if (hermesTags.length > 0) {
        return hermesTags;
      }
    }
  }
  return [];
}

function mergeFrontmatter(
  fromMd: Record<string, unknown> | null,
  fromYaml: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!fromMd && !fromYaml) {
    return null;
  }
  return { ...(fromMd ?? {}), ...(fromYaml ?? {}) };
}

export interface ParseSkillOptions {
  source?: SkillSource;
  scope?: SkillScope;
}

export function parseSkillMetadata(
  skillDir: string,
  fallbackId: string,
  opts: ParseSkillOptions = {},
): SkillMetadata {
  const warnings: string[] = [];
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const skillYamlPath = path.join(skillDir, 'skill.yaml');

  const hasSkillMd = fs.existsSync(skillMdPath);
  const hasSkillYaml = fs.existsSync(skillYamlPath);

  let mdFrontmatter: Record<string, unknown> | null = null;
  let body = '';
  if (hasSkillMd) {
    try {
      const text = fs.readFileSync(skillMdPath, 'utf8');
      const { data, body: rest } = extractFrontmatter(text);
      mdFrontmatter = data;
      body = rest;
    } catch (err) {
      warnings.push(`failed to read SKILL.md: ${(err as Error).message}`);
    }
  } else {
    warnings.push('SKILL.md is missing');
  }

  let yamlData: Record<string, unknown> | null = null;
  if (hasSkillYaml) {
    try {
      const text = fs.readFileSync(skillYamlPath, 'utf8');
      const parsed = YAML.parse(text) as Record<string, unknown> | null;
      yamlData = parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      warnings.push(`failed to parse skill.yaml: ${(err as Error).message}`);
    }
  }

  const frontmatter = mergeFrontmatter(mdFrontmatter, yamlData);

  let id = fallbackId;
  if (frontmatter && typeof frontmatter.id === 'string' && frontmatter.id.trim()) {
    id = frontmatter.id.trim();
  } else if (frontmatter && typeof frontmatter.name === 'string' && frontmatter.name.trim()) {
    id = frontmatter.name.trim();
  }
  // For consistency with directory-based discovery, prefer the directory name as id.
  // Frontmatter `name` is used for title/summary derivation but does not override id.
  id = fallbackId;

  return {
    id,
    title: deriveTitle(frontmatter, body, fallbackId),
    summary: deriveSummary(frontmatter, body),
    tags: deriveTags(frontmatter),
    source: opts.source ?? 'user-profile',
    scope: opts.scope ?? 'default',
    path: skillDir,
    has_skill_md: hasSkillMd,
    has_skill_yaml: hasSkillYaml,
    warnings,
  };
}
