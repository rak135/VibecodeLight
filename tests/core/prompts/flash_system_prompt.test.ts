import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

import { resolveUserProfileDir } from '../../../src/core/config/user_profile.js';
import { resolveFlashSystemPrompt } from '../../../src/core/prompts/flash_system_prompt.js';

function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function makeRepoRoot(prefix = 'vibecode-flash-system-prompt-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePrompt(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('resolveFlashSystemPrompt', () => {
  test('bundled default loaded when no overrides present', () => {
    const repoRoot = makeRepoRoot();
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-localappdata-'));
    const bundledPromptPath = path.join(repoRoot, 'resources', 'prompts', 'flash_system.md');
    const bundledContent = [
      'You are a flash model for a coding context pipeline.',
      'Return ONLY the required Markdown contract with exactly 8 sections — no preamble, no explanation.',
    ].join('\n');

    try {
      writePrompt(bundledPromptPath, bundledContent);

      const resolved = resolveFlashSystemPrompt({
        repoRoot,
        env: { LOCALAPPDATA: localAppData },
        bundledPromptPath,
      });

      expect(resolved).toEqual({
        content: bundledContent,
        source: 'bundled-default',
        resolvedPath: bundledPromptPath,
        sha256: sha256Of(bundledContent),
        bytes: Buffer.byteLength(bundledContent, 'utf8'),
        warnings: [],
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });

  test('user-profile override wins over bundled default', () => {
    const repoRoot = makeRepoRoot();
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-localappdata-'));
    const env = { LOCALAPPDATA: localAppData };
    const bundledPromptPath = path.join(repoRoot, 'resources', 'prompts', 'flash_system.md');
    const userPromptPath = path.join(resolveUserProfileDir(env), 'prompts', 'flash_system.md');
    const bundledContent = 'bundled default flash system prompt';
    const userContent = 'user profile flash system prompt';

    try {
      writePrompt(bundledPromptPath, bundledContent);
      writePrompt(userPromptPath, userContent);

      const resolved = resolveFlashSystemPrompt({ repoRoot, env, bundledPromptPath });

      expect(resolved.source).toBe('user-profile');
      expect(resolved.content).toBe(userContent);
      expect(resolved.resolvedPath).toBe(userPromptPath);
      expect(resolved.sha256).toBe(sha256Of(userContent));
      expect(resolved.bytes).toBe(Buffer.byteLength(userContent, 'utf8'));
      expect(resolved.warnings).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });

  test('project-local override wins over user-profile', () => {
    const repoRoot = makeRepoRoot();
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-localappdata-'));
    const env = { LOCALAPPDATA: localAppData };
    const bundledPromptPath = path.join(repoRoot, 'resources', 'prompts', 'flash_system.md');
    const userPromptPath = path.join(resolveUserProfileDir(env), 'prompts', 'flash_system.md');
    const projectPromptPath = path.join(repoRoot, '.vibecode', 'prompts', 'flash_system.md');
    const bundledContent = 'bundled default flash system prompt';
    const userContent = 'user profile flash system prompt';
    const projectContent = 'project local flash system prompt';

    try {
      writePrompt(bundledPromptPath, bundledContent);
      writePrompt(userPromptPath, userContent);
      writePrompt(projectPromptPath, projectContent);

      const resolved = resolveFlashSystemPrompt({ repoRoot, env, bundledPromptPath });

      expect(resolved.source).toBe('project-local');
      expect(resolved.content).toBe(projectContent);
      expect(resolved.resolvedPath).toBe(projectPromptPath);
      expect(resolved.sha256).toBe(sha256Of(projectContent));
      expect(resolved.bytes).toBe(Buffer.byteLength(projectContent, 'utf8'));
      expect(resolved.warnings).toEqual([]);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });

  test('empty override is ignored with warning, fallback used', () => {
    const repoRoot = makeRepoRoot();
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-localappdata-'));
    const env = { LOCALAPPDATA: localAppData };
    const bundledPromptPath = path.join(repoRoot, 'resources', 'prompts', 'flash_system.md');
    const userPromptPath = path.join(resolveUserProfileDir(env), 'prompts', 'flash_system.md');
    const projectPromptPath = path.join(repoRoot, '.vibecode', 'prompts', 'flash_system.md');
    const bundledContent = 'bundled default flash system prompt';
    const userContent = 'user profile flash system prompt';

    try {
      writePrompt(bundledPromptPath, bundledContent);
      writePrompt(userPromptPath, userContent);
      writePrompt(projectPromptPath, '   \n\n  ');

      const resolved = resolveFlashSystemPrompt({ repoRoot, env, bundledPromptPath });

      expect(resolved.source).toBe('user-profile');
      expect(resolved.content).toBe(userContent);
      expect(resolved.resolvedPath).toBe(userPromptPath);
      expect(resolved.warnings).toHaveLength(1);
      expect(resolved.warnings[0]).toContain(projectPromptPath);
      expect(resolved.warnings[0]).toContain('empty');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });

  test('adapter no longer owns SYSTEM_PROMPT constant and FlashInput has systemPrompt field', () => {
    const baseSource = fs.readFileSync(path.resolve(__dirname, '../../../src/adapters/llm/base.ts'), 'utf8');
    const adapterSource = fs.readFileSync(path.resolve(__dirname, '../../../src/adapters/llm/openai_compatible_adapter.ts'), 'utf8');

    expect(baseSource).toContain('systemPrompt: string;');
    expect(adapterSource).toContain("content: input.systemPrompt");
    expect(adapterSource).not.toContain('const SYSTEM_PROMPT');
  });

  test('two runs with same resolved prompt produce same sha256', () => {
    const repoRootA = makeRepoRoot('vibecode-flash-system-prompt-a-');
    const repoRootB = makeRepoRoot('vibecode-flash-system-prompt-b-');
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-localappdata-'));
    const env = { LOCALAPPDATA: localAppData };
    const bundledContent = 'stable flash system prompt content';
    const bundledPromptPathA = path.join(repoRootA, 'resources', 'prompts', 'flash_system.md');
    const bundledPromptPathB = path.join(repoRootB, 'resources', 'prompts', 'flash_system.md');

    try {
      writePrompt(bundledPromptPathA, bundledContent);
      writePrompt(bundledPromptPathB, bundledContent);

      const resolvedA = resolveFlashSystemPrompt({ repoRoot: repoRootA, env, bundledPromptPath: bundledPromptPathA });
      const resolvedB = resolveFlashSystemPrompt({ repoRoot: repoRootB, env, bundledPromptPath: bundledPromptPathB });

      expect(resolvedA.sha256).toBe(resolvedB.sha256);
      expect(resolvedA.sha256).toBe(sha256Of(bundledContent));
      expect(resolvedA.bytes).toBe(resolvedB.bytes);
    } finally {
      fs.rmSync(repoRootA, { recursive: true, force: true });
      fs.rmSync(repoRootB, { recursive: true, force: true });
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });
});
