import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { resolveUserProfileDir } from '../config/user_profile.js';

export interface ResolvedFlashSystemPrompt {
  content: string;
  source: 'project-local' | 'user-profile' | 'bundled-default';
  resolvedPath?: string;
  sha256: string;
  bytes: number;
  warnings: string[];
}

export interface ResolveFlashSystemPromptOptions {
  repoRoot: string;
  env: Record<string, string | undefined>;
  bundledPromptPath: string;
}

export interface FlashSystemPromptArtifacts {
  promptPath: string;
  metaPath: string;
}

type FlashPromptSource = ResolvedFlashSystemPrompt['source'];

function buildResolvedFlashSystemPrompt(
  content: string,
  source: FlashPromptSource,
  resolvedPath: string,
  warnings: string[],
): ResolvedFlashSystemPrompt {
  return {
    content,
    source,
    resolvedPath,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
    warnings: [...warnings],
  };
}

function readPromptCandidate(
  candidate: { source: FlashPromptSource; filePath: string },
  warnings: string[],
): ResolvedFlashSystemPrompt | undefined {
  if (!fs.existsSync(candidate.filePath)) {
    return undefined;
  }

  const content = fs.readFileSync(candidate.filePath, 'utf8');
  if (content.trim().length === 0) {
    warnings.push(`Ignored empty flash system prompt override at ${candidate.filePath}; falling back to next source.`);
    return undefined;
  }

  return buildResolvedFlashSystemPrompt(content, candidate.source, candidate.filePath, warnings);
}

export function resolveFlashSystemPrompt(opts: ResolveFlashSystemPromptOptions): ResolvedFlashSystemPrompt {
  const warnings: string[] = [];
  const projectPromptPath = path.join(opts.repoRoot, '.vibecode', 'prompts', 'flash_system.md');
  const userPromptPath = path.join(resolveUserProfileDir(opts.env), 'prompts', 'flash_system.md');

  const candidates = [
    { source: 'project-local' as const, filePath: projectPromptPath },
    { source: 'user-profile' as const, filePath: userPromptPath },
    { source: 'bundled-default' as const, filePath: opts.bundledPromptPath },
  ];

  for (const candidate of candidates) {
    const resolved = readPromptCandidate(candidate, warnings);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(`Missing bundled flash system prompt at ${opts.bundledPromptPath}`);
}

export function writeFlashSystemPromptArtifacts(
  flashDir: string,
  resolved: ResolvedFlashSystemPrompt,
): FlashSystemPromptArtifacts {
  fs.mkdirSync(flashDir, { recursive: true });

  const promptPath = path.join(flashDir, 'flash_system_prompt.md');
  const metaPath = path.join(flashDir, 'flash_prompt_meta.json');

  fs.writeFileSync(promptPath, resolved.content, 'utf8');
  fs.writeFileSync(metaPath, `${JSON.stringify({
    source: resolved.source,
    resolvedPath: resolved.resolvedPath,
    sha256: resolved.sha256,
    bytes: resolved.bytes,
    warnings: resolved.warnings,
  }, null, 2)}\n`, 'utf8');

  return { promptPath, metaPath };
}
