import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

import {
  readCodeGraphBinarySetting,
  resetCodeGraphBinarySetting,
  writeCodeGraphBinarySetting,
} from '../../src/core/config/codegraph_binary_config.js';

function makeGlobalConfigPath(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-core-codegraph-binary-'));
  return { dir, file: path.join(dir, 'config.yaml') };
}

describe('core CodeGraph binary global config setting', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  test('returns null binary when the global config is missing', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);

    const setting = readCodeGraphBinarySetting({ globalConfigPath: file });

    expect(setting).toMatchObject({
      binary: null,
      source: 'default',
      globalConfigPath: file,
      globalConfigExists: false,
      warnings: [],
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('set <path> persists defaults.codegraph.binary in global config alongside transport', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(
      file,
      YAML.stringify({
        version: 1,
        providers: {},
        defaults: { flash: { provider: 'mock' }, codegraph: { transport: 'mcp' } },
      }),
      'utf8',
    );

    const written = writeCodeGraphBinarySetting({ globalConfigPath: file, binary: 'C:/bin/codegraph.exe' });

    expect(written).toMatchObject({
      binary: 'C:/bin/codegraph.exe',
      source: 'global',
      artifactPath: file,
    });
    const saved = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      defaults: {
        codegraph: { binary: 'C:/bin/codegraph.exe', transport: 'mcp' },
        flash: { provider: 'mock' },
      },
    });
  });

  test('reset removes the binary key and keeps transport untouched', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(
      file,
      YAML.stringify({
        version: 1,
        defaults: { codegraph: { binary: 'C:/bin/codegraph.exe', transport: 'auto' } },
      }),
      'utf8',
    );

    const reset = resetCodeGraphBinarySetting({ globalConfigPath: file });
    const reread = readCodeGraphBinarySetting({ globalConfigPath: file });

    expect(reset.binary).toBeNull();
    expect(reread.binary).toBeNull();
    const saved = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ defaults: { codegraph: { transport: 'auto' } } });
    expect((saved as { defaults: { codegraph: Record<string, unknown> } }).defaults.codegraph.binary).toBeUndefined();
  });

  test('empty string binary value is rejected with structured error', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);

    expect(() => writeCodeGraphBinarySetting({ globalConfigPath: file, binary: '   ' })).toThrow(
      /INVALID_CODEGRAPH_BINARY/,
    );
    expect(fs.existsSync(file)).toBe(false);
  });
});
