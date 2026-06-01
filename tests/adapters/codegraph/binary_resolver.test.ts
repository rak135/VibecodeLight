import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

import { resolveCodeGraphBinary } from '../../../src/adapters/codegraph/codegraph_binary_resolver.js';

function makeGlobalConfig(value?: unknown): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cg-bin-resolver-'));
  const file = path.join(dir, 'config.yaml');
  if (value !== undefined) fs.writeFileSync(file, YAML.stringify(value), 'utf8');
  return { dir, file };
}

describe('resolveCodeGraphBinary', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  test('returns CLI option when provided', () => {
    const { dir, file } = makeGlobalConfig({
      version: 1,
      defaults: { codegraph: { binary: 'C:/from/config.exe' } },
    });
    cleanup.push(dir);
    const result = resolveCodeGraphBinary({
      cliOption: 'C:/from/cli.exe',
      env: { VIBECODE_CODEGRAPH_BIN: 'C:/from/env.exe' },
      globalConfigPath: file,
    });
    expect(result).toEqual({
      command: 'C:/from/cli.exe',
      source: 'CLI_OPTION',
      configured: 'C:/from/cli.exe',
    });
  });

  test('env VIBECODE_CODEGRAPH_BIN overrides global config', () => {
    const { dir, file } = makeGlobalConfig({
      version: 1,
      defaults: { codegraph: { binary: 'C:/from/config.exe' } },
    });
    cleanup.push(dir);
    const result = resolveCodeGraphBinary({
      env: { VIBECODE_CODEGRAPH_BIN: 'C:/from/env.exe' },
      globalConfigPath: file,
    });
    expect(result).toEqual({
      command: 'C:/from/env.exe',
      source: 'VIBECODE_CODEGRAPH_BIN',
      configured: 'C:/from/env.exe',
    });
  });

  test('global config overrides PATH fallback', () => {
    const { dir, file } = makeGlobalConfig({
      version: 1,
      defaults: { codegraph: { binary: 'C:/from/config.exe' } },
    });
    cleanup.push(dir);
    const result = resolveCodeGraphBinary({
      env: {},
      globalConfigPath: file,
    });
    expect(result).toEqual({
      command: 'C:/from/config.exe',
      source: 'GLOBAL_CONFIG',
      configured: 'C:/from/config.exe',
    });
  });

  test('fallback is exactly "codegraph" when no override exists', () => {
    const { dir, file } = makeGlobalConfig();
    cleanup.push(dir);
    const result = resolveCodeGraphBinary({
      env: {},
      globalConfigPath: file,
    });
    expect(result).toEqual({
      command: 'codegraph',
      source: 'PATH_FALLBACK',
      configured: null,
    });
  });

  test('empty CLI option is ignored', () => {
    const { dir, file } = makeGlobalConfig();
    cleanup.push(dir);
    const result = resolveCodeGraphBinary({
      cliOption: '   ',
      env: {},
      globalConfigPath: file,
    });
    expect(result.source).toBe('PATH_FALLBACK');
    expect(result.command).toBe('codegraph');
  });

  test('empty env value is ignored', () => {
    const { dir, file } = makeGlobalConfig({
      version: 1,
      defaults: { codegraph: { binary: 'C:/from/config.exe' } },
    });
    cleanup.push(dir);
    const result = resolveCodeGraphBinary({
      env: { VIBECODE_CODEGRAPH_BIN: '' },
      globalConfigPath: file,
    });
    expect(result.source).toBe('GLOBAL_CONFIG');
    expect(result.command).toBe('C:/from/config.exe');
  });

  test('empty global config value falls through to PATH fallback', () => {
    const { dir, file } = makeGlobalConfig({
      version: 1,
      defaults: { codegraph: { binary: '   ' } },
    });
    cleanup.push(dir);
    const result = resolveCodeGraphBinary({
      env: {},
      globalConfigPath: file,
    });
    expect(result.source).toBe('PATH_FALLBACK');
    expect(result.configured).toBeNull();
  });
});
