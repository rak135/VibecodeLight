import fs from 'fs';
import os from 'os';
import path from 'path';

import { OpenAiCompatibleAdapter } from '../../src/adapters/llm/openai_compatible_adapter.js';
import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';

const VALID_FLASH_MARKDOWN = [
  '# Task Summary',
  'Config resolution artifact integration fixture.',
  '',
  '# Relevant Files',
  '- README.md — fixture repository overview',
  '',
  '# Files To Read With Tools',
  '- README.md — inspect repository overview before implementation',
  '',
  '# Relevant Tests',
  '- pnpm test — run the default test suite',
  '',
  '# Commands To Run',
  '- pnpm test — run the default test suite',
  '',
  '# Selected Skills',
  '- test-driven-development — validate contract before changing code',
  '',
  '# Cautions',
  '- fixture only',
  '',
  '# Context Pack',
  'Deterministic fixture context pack.',
  '',
].join('\n');

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-config-artifact-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  return repoRoot;
}

function fakeLiveFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: VALID_FLASH_MARKDOWN } }] }),
  } as Response);
}

describe('config resolution artifact', () => {
  test('mock prompt run writes config_resolution.json and provider provenance into flash_output_meta', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runPromptPipeline({ task: 'mock config resolution artifact', repoRoot, mock: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const resolutionPath = path.join(result.runDir, 'config_resolution.json');
      expect(fs.existsSync(resolutionPath)).toBe(true);
      const resolution = JSON.parse(fs.readFileSync(resolutionPath, 'utf8'));
      expect(resolution).toHaveProperty('global_config_path');
      expect(resolution).toHaveProperty('global_env_path');
      expect(resolution).toHaveProperty('local_config_path');
      expect(resolution).toHaveProperty('selected_config_source');
      expect(resolution.source_map).toHaveProperty('apiKey');
      expect(resolution.provider).toBe('mock');

      const meta = JSON.parse(fs.readFileSync(path.join(result.runDir, 'flash', 'flash_output_meta.json'), 'utf8'));
      expect(meta.provider).toBe('mock');
      expect(meta.live).toBe(false);
      expect(meta).toHaveProperty('config_resolution_path');
      expect(meta).toHaveProperty('config_source');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('local config is created when missing and snapshot status is recorded', async () => {
    const repoRoot = makeRepo();
    try {
      expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(false);
      const result = await runPromptPipeline({ task: 'creates local config', repoRoot, mock: true });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'config.yaml'))).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('fake live provider pipeline writes config_resolution.json with no secret', async () => {
    const repoRoot = makeRepo();
    const adapter = new OpenAiCompatibleAdapter(
      {
        provider: 'openrouter',
        apiKey: 'secret-api-key-live',
        baseUrl: 'https://api.example.com/v1',
        live: true,
      },
      fakeLiveFetch() as typeof fetch,
    );
    try {
      const result = await runPromptPipeline({ task: 'fake live config resolution', repoRoot, mock: false, adapter });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const resolutionPath = path.join(result.runDir, 'config_resolution.json');
      expect(fs.existsSync(resolutionPath)).toBe(true);
      const written = fs.readFileSync(resolutionPath, 'utf8');
      expect(written).not.toContain('secret-api-key-live');

      const meta = JSON.parse(fs.readFileSync(path.join(result.runDir, 'flash', 'flash_output_meta.json'), 'utf8'));
      expect(meta.provider).toBe('openrouter');
      expect(meta.live).toBe(true);
      expect(meta.baseUrl_host).toBe('api.example.com');
      expect(JSON.stringify(meta)).not.toContain('secret-api-key-live');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
