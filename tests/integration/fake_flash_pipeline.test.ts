import fs from 'fs';
import os from 'os';
import path from 'path';

import { OpenAiCompatibleAdapter } from '../../src/adapters/llm/openai_compatible_adapter.js';
import { parseFlashOutput } from '../../src/core/context/markdown_flash_output_parser.js';
import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';

const VALID_FLASH_MARKDOWN = [
  '# Task Summary',
  'Integration live flash output for the pipeline tests.',
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
  '- live provider test fixture only; do not treat as model guidance',
  '',
  '# Context Pack',
  'This live flash context pack is deterministic for integration tests.',
  'It validates the full prompt pipeline.',
  '',
].join('\n');

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-live-flash-pipeline-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

function fakeLiveFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: VALID_FLASH_MARKDOWN } }] }),
  } as Response);
}

describe('fake flash pipeline integration', () => {
  test('prompt without --mock fails FLASH_PROVIDER_NOT_CONFIGURED when no live provider is configured', async () => {
    const repoRoot = makeRepo();

    try {
      const result = await runPromptPipeline({
        task: 'missing live provider integration test',
        repoRoot,
        mock: false,
        live: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // With --live flag and no provider configured, expect FLASH_PROVIDER_NOT_CONFIGURED
      expect(['FLASH_PROVIDER_NOT_CONFIGURED', 'FLASH_MODE_REQUIRED']).toContain(result.error.code);
      expect(result.error.message).not.toMatch(/api key/i);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('prompt --mock never calls a live provider', async () => {
    const repoRoot = makeRepo();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();

    try {
      (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch = fetchSpy as typeof fetch;

      const result = await runPromptPipeline({
        task: 'mock regression integration test',
        repoRoot,
        mock: true,
      });

      expect(result.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch = originalFetch;
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('fake live provider writes flash_output.md that validates', async () => {
    const repoRoot = makeRepo();
    const adapter = new OpenAiCompatibleAdapter(
      {
        provider: 'openrouter',
        apiKey: 'secret-api-key',
        baseUrl: 'https://api.example.com/v1',
        live: true,
      },
      fakeLiveFetch() as typeof fetch,
    );

    try {
      const result = await runPromptPipeline({
        task: 'fake live provider writes flash output',
        repoRoot,
        mock: false,
        adapter,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flashOutputPath = path.join(result.runDir, 'flash', 'flash_output.md');
      expect(fs.existsSync(flashOutputPath)).toBe(true);
      const parsed = parseFlashOutput(fs.readFileSync(flashOutputPath, 'utf8'), flashOutputPath);
      expect(parsed.ok).toBe(true);
      expect(fs.readFileSync(flashOutputPath, 'utf8')).not.toContain('secret-api-key');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('fake live provider runs the full pipeline and writes context_pack.md and final_prompt.md', async () => {
    const repoRoot = makeRepo();
    const adapter = new OpenAiCompatibleAdapter(
      {
        provider: 'openrouter',
        apiKey: 'secret-api-key',
        baseUrl: 'https://api.example.com/v1',
        live: true,
      },
      fakeLiveFetch() as typeof fetch,
    );

    try {
      const result = await runPromptPipeline({
        task: 'fake live provider full pipeline',
        repoRoot,
        mock: false,
        adapter,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const contextPackPath = path.join(result.runDir, 'output', 'context_pack.md');
      const finalPromptPath = path.join(result.runDir, 'output', 'final_prompt.md');
      expect(fs.existsSync(contextPackPath)).toBe(true);
      expect(fs.existsSync(finalPromptPath)).toBe(true);
      expect(fs.readFileSync(finalPromptPath, 'utf8')).toContain('fake live provider full pipeline');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('live pipeline does not create after/ artifacts', async () => {
    const repoRoot = makeRepo();
    const adapter = new OpenAiCompatibleAdapter(
      {
        provider: 'openrouter',
        apiKey: 'secret-api-key',
        baseUrl: 'https://api.example.com/v1',
        live: true,
      },
      fakeLiveFetch() as typeof fetch,
    );

    try {
      const result = await runPromptPipeline({
        task: 'no after artifacts integration',
        repoRoot,
        mock: false,
        adapter,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(fs.existsSync(path.join(result.runDir, 'after'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'after', 'git_status_after.json'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'after', 'changed_files_after.json'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'after', 'checks_summary.md'))).toBe(false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
