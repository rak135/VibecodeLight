import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  enrichFlashOutputMeta,
  writeFlashOutputMeta,
  type FlashOutputMeta,
  type FlashRunMeta,
} from '../../../src/core/context/flash_output_meta.js';

function makeFlashDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAdapterMeta(overrides: Partial<FlashOutputMeta> = {}): FlashOutputMeta {
  return {
    task_summary: 'Fixture task summary.',
    constraints: ['c1'],
    validation_hints: ['v1'],
    selected_skills: ['test-driven-development'],
    relevant_files: ['README.md'],
    files_to_read_with_tools: ['README.md'],
    relevant_tests: ['pnpm test'],
    commands_to_run: ['pnpm test'],
    cautions: ['fixture caution'],
    warnings: [],
    ...overrides,
  };
}

function makeRunMeta(overrides: Partial<FlashRunMeta> = {}): FlashRunMeta {
  return {
    provider: 'openrouter',
    provider_label: 'OpenRouter',
    model: 'deepseek/deepseek-chat',
    model_label: 'DeepSeek Chat via OpenRouter',
    live: true,
    baseUrl_host: 'openrouter.ai',
    config_source: 'global-config',
    config_resolution_path: '/tmp/fixture/config_resolution.json',
    ...overrides,
  };
}

describe('enrichFlashOutputMeta', () => {
  test('merges run-meta fields into an existing flash_output_meta.json without dropping adapter-owned fields', () => {
    const flashDir = makeFlashDir('vibecode-enrich-meta-merge-');
    try {
      const adapterMeta = makeAdapterMeta();
      const writtenPath = writeFlashOutputMeta(flashDir, adapterMeta);
      expect(writtenPath).toBe(path.join(flashDir, 'flash_output_meta.json'));

      const runMeta = makeRunMeta();
      const returnedPath = enrichFlashOutputMeta(flashDir, runMeta);
      const metaPath = path.join(flashDir, 'flash_output_meta.json');
      expect(returnedPath).toBe(metaPath);

      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;

      // Adapter-owned fields are preserved unchanged.
      expect(parsed.task_summary).toBe(adapterMeta.task_summary);
      expect(parsed.constraints).toEqual(adapterMeta.constraints);
      expect(parsed.validation_hints).toEqual(adapterMeta.validation_hints);
      expect(parsed.selected_skills).toEqual(adapterMeta.selected_skills);
      expect(parsed.relevant_files).toEqual(adapterMeta.relevant_files);
      expect(parsed.files_to_read_with_tools).toEqual(adapterMeta.files_to_read_with_tools);
      expect(parsed.relevant_tests).toEqual(adapterMeta.relevant_tests);
      expect(parsed.commands_to_run).toEqual(adapterMeta.commands_to_run);
      expect(parsed.cautions).toEqual(adapterMeta.cautions);
      expect(parsed.warnings).toEqual(adapterMeta.warnings);

      // Run-meta fields are added.
      expect(parsed.provider).toBe(runMeta.provider);
      expect(parsed.provider_label).toBe(runMeta.provider_label);
      expect(parsed.model).toBe(runMeta.model);
      expect(parsed.model_label).toBe(runMeta.model_label);
      expect(parsed.live).toBe(runMeta.live);
      expect(parsed.baseUrl_host).toBe(runMeta.baseUrl_host);
      expect(parsed.config_source).toBe(runMeta.config_source);
      expect(parsed.config_resolution_path).toBe(runMeta.config_resolution_path);
    } finally {
      fs.rmSync(flashDir, { recursive: true, force: true });
    }
  });

  test('creates flash_output_meta.json with run-meta fields when the file does not exist', () => {
    const flashDir = makeFlashDir('vibecode-enrich-meta-create-');
    try {
      const metaPath = path.join(flashDir, 'flash_output_meta.json');
      expect(fs.existsSync(metaPath)).toBe(false);

      const runMeta = makeRunMeta({
        provider: 'mock',
        provider_label: null,
        model: null,
        model_label: null,
        live: false,
        baseUrl_host: null,
        config_source: null,
        config_resolution_path: '/tmp/fixture/config_resolution.json',
      });
      const returnedPath = enrichFlashOutputMeta(flashDir, runMeta);

      expect(returnedPath).toBe(metaPath);
      expect(fs.existsSync(metaPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      expect(parsed).toEqual({
        provider: runMeta.provider,
        provider_label: runMeta.provider_label,
        model: runMeta.model,
        model_label: runMeta.model_label,
        live: runMeta.live,
        baseUrl_host: runMeta.baseUrl_host,
        config_source: runMeta.config_source,
        config_resolution_path: runMeta.config_resolution_path,
      });
    } finally {
      fs.rmSync(flashDir, { recursive: true, force: true });
    }
  });

  test('recovers from malformed existing JSON: does not throw, rewrites with run-meta only, returns the meta path', () => {
    const flashDir = makeFlashDir('vibecode-enrich-meta-malformed-');
    try {
      const metaPath = path.join(flashDir, 'flash_output_meta.json');
      const malformed = '{ this is : not valid json,,, ';
      fs.writeFileSync(metaPath, malformed, 'utf8');
      expect(fs.readFileSync(metaPath, 'utf8')).toBe(malformed);

      const runMeta = makeRunMeta();
      let returnedPath: string | undefined;
      expect(() => {
        returnedPath = enrichFlashOutputMeta(flashDir, runMeta);
      }).not.toThrow();

      expect(returnedPath).toBe(metaPath);
      expect(fs.existsSync(metaPath)).toBe(true);

      const written = fs.readFileSync(metaPath, 'utf8');
      // Malformed payload is not preserved.
      expect(written).not.toContain('this is : not valid json');

      const parsed = JSON.parse(written) as Record<string, unknown>;
      expect(parsed).toEqual({
        provider: runMeta.provider,
        provider_label: runMeta.provider_label,
        model: runMeta.model,
        model_label: runMeta.model_label,
        live: runMeta.live,
        baseUrl_host: runMeta.baseUrl_host,
        config_source: runMeta.config_source,
        config_resolution_path: runMeta.config_resolution_path,
      });
    } finally {
      fs.rmSync(flashDir, { recursive: true, force: true });
    }
  });
});
