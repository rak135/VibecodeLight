import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

import {
  readCodeGraphTransportSetting,
  resetCodeGraphTransportSetting,
  writeCodeGraphTransportSetting,
} from '../../src/core/config/codegraph_transport_config.js';

function makeGlobalConfigPath(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-core-codegraph-transport-'));
  return { dir, file: path.join(dir, 'config.yaml') };
}

describe('core CodeGraph transport global config setting', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  test('defaults to cli when the global config is missing', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);

    const setting = readCodeGraphTransportSetting({ globalConfigPath: file });

    expect(setting).toMatchObject({
      transport: 'cli',
      default: 'cli',
      source: 'default',
      globalConfigPath: file,
      globalConfigExists: false,
      warnings: [],
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('set mcp persists defaults.codegraph.transport in the global config', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({ version: 1, providers: {}, defaults: { flash: { provider: 'mock' } } }), 'utf8');

    const written = writeCodeGraphTransportSetting({ globalConfigPath: file, transport: 'mcp' });

    expect(written).toMatchObject({ transport: 'mcp', source: 'global', artifactPath: file });
    const saved = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      defaults: {
        flash: { provider: 'mock' },
        codegraph: { transport: 'mcp' },
      },
    });
  });

  test('reset removes the global config transport and subsequent reads return cli', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({ version: 1, defaults: { codegraph: { transport: 'auto' } } }), 'utf8');

    const reset = resetCodeGraphTransportSetting({ globalConfigPath: file });
    const reread = readCodeGraphTransportSetting({ globalConfigPath: file });

    expect(reset.transport).toBe('cli');
    expect(reset.source).toBe('default');
    expect(reread).toMatchObject({ transport: 'cli', source: 'default' });
    const saved = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved).not.toMatchObject({ defaults: { codegraph: { transport: 'auto' } } });
  });

  test('invalid global config value resolves to cli with a warning', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({ version: 1, defaults: { codegraph: { transport: 'socket' } } }), 'utf8');

    const setting = readCodeGraphTransportSetting({ globalConfigPath: file });

    expect(setting.transport).toBe('cli');
    expect(setting.source).toBe('default');
    expect(setting.warnings.join('\n')).toContain('INVALID_CODEGRAPH_TRANSPORT_CONFIG');
  });
});
