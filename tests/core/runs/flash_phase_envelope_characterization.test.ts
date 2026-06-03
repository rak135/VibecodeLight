import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';
import { describe, expect, test } from 'vitest';

import { performFlashPhase } from '../../../src/core/runs/flash_phase.js';
import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';
import { resolveFlashConfig } from '../../../src/core/config/index.js';
import { resolveFlashSystemPrompt } from '../../../src/core/prompts/flash_system_prompt.js';

const BUNDLED_FLASH_SYSTEM_PROMPT_PATH = path.resolve(
  __dirname,
  '../../../resources/prompts/flash_system.md',
);

const REGISTRY = {
  version: 1,
  providers: {
    openrouter: {
      type: 'openai-compatible',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      api_key_env: 'OPENROUTER_API_KEY',
      models: [
        {
          id: 'deepseek/deepseek-chat',
          label: 'DeepSeek Chat via OpenRouter',
          role: 'flash',
        },
      ],
    },
  },
  defaults: { flash: { provider: 'openrouter', model: 'deepseek/deepseek-chat' } },
};

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'fixture.ts'),
    'export const fixture = true;\n',
    'utf8',
  );
  return repoRoot;
}

function makeAppDataWithProvider(): string {
  const appData = fs.mkdtempSync(
    path.join(os.tmpdir(), 'vibecode-flash-phase-char-appdata-'),
  );
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), YAML.stringify(REGISTRY), 'utf8');
  fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=test-key-fixture\n', 'utf8');
  return appData;
}

async function seedRunWithFlashInput(repoRoot: string): Promise<{ runId: string; runDir: string }> {
  const result = await runPromptPipeline({
    task: 'flash phase envelope characterization seed',
    repoRoot,
    mock: true,
  });
  if (!result.ok) {
    throw new Error(`seed pipeline failed: ${result.error.code}: ${result.error.message}`);
  }
  return { runId: result.run_id, runDir: result.runDir };
}

describe('performFlashPhase envelope characterization', () => {
  test('mock-mode happy path returns canonical 5-element artifacts list, status ok, ids/paths, and warnings concatenation', async () => {
    const repoRoot = makeRepo('vibecode-flash-phase-char-ok-');
    try {
      const { runId, runDir } = await seedRunWithFlashInput(repoRoot);

      const result = await performFlashPhase({
        runId,
        runDir,
        repoRoot,
        mock: true,
        bundledFlashSystemPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
      });

      const expectedFlashDir = path.join(runDir, 'flash');
      const expectedArtifacts = [
        path.join(expectedFlashDir, 'flash_system_prompt.md'),
        path.join(expectedFlashDir, 'flash_prompt_meta.json'),
        path.join(expectedFlashDir, 'flash_output.md'),
        path.join(expectedFlashDir, 'flash_output_meta.json'),
        path.join(expectedFlashDir, 'tool_calls.json'),
      ];

      expect(result.status).toBe('ok');
      expect(result.run_id).toBe(runId);
      expect(result.runDir).toBe(runDir);
      expect(result.flashDir).toBe(expectedFlashDir);
      expect(result.artifacts).toEqual(expectedArtifacts);
      for (const artifactPath of expectedArtifacts) {
        expect(fs.existsSync(artifactPath)).toBe(true);
      }

      // Characterize warnings as the concatenation of the same two public
      // helpers performFlashPhase uses internally, evaluated against the same
      // repo/env state at the same moment in time.
      const resolved = resolveFlashConfig({
        repoRoot,
        env: process.env,
        mock: true,
      });
      const resolvedPrompt = resolveFlashSystemPrompt({
        repoRoot,
        bundledPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
        env: process.env,
      });
      const expectedWarnings = [
        ...resolved.resolution.warnings,
        ...resolvedPrompt.warnings,
      ];
      expect(result.warnings).toEqual(expectedWarnings);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('missing run dir returns error envelope with code RUN_NOT_FOUND', async () => {
    const repoRoot = makeRepo('vibecode-flash-phase-char-no-run-');
    try {
      const runId = '20260101-000000-NONE';
      const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
      // Intentionally do not create runDir.
      expect(fs.existsSync(runDir)).toBe(false);

      const result = await performFlashPhase({
        runId,
        runDir,
        repoRoot,
        mock: true,
        bundledFlashSystemPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
      });

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('RUN_NOT_FOUND');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('missing flash input returns error envelope with code FLASH_INPUT_NOT_FOUND', async () => {
    const repoRoot = makeRepo('vibecode-flash-phase-char-no-input-');
    try {
      const runId = '20260101-000000-NOINP';
      const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
      fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
      expect(fs.existsSync(path.join(runDir, 'flash'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input.md'))).toBe(false);

      const result = await performFlashPhase({
        runId,
        runDir,
        repoRoot,
        mock: true,
        bundledFlashSystemPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
      });

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('FLASH_INPUT_NOT_FOUND');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('valid provider config without mock and without live returns error envelope with code LIVE_PROVIDER_DISABLED', async () => {
    const repoRoot = makeRepo('vibecode-flash-phase-char-live-disabled-');
    const appData = makeAppDataWithProvider();
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = appData;
    try {
      const { runId, runDir } = await seedRunWithFlashInput(repoRoot);

      const result = await performFlashPhase({
        runId,
        runDir,
        repoRoot,
        // mock and live both intentionally unset
        flashProvider: 'openrouter',
        flashModel: 'deepseek/deepseek-chat',
        bundledFlashSystemPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
      });

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('LIVE_PROVIDER_DISABLED');
    } finally {
      process.env.LOCALAPPDATA = originalLocalAppData;
      fs.rmSync(appData, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
