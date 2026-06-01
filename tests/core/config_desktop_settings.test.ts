import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

import {
  readDesktopAutoApproveEnabledSetting,
  readDesktopCodeGraphModeSetting,
  readDesktopTaskNormalizerEnabledSetting,
  resetDesktopAutoApproveEnabledSetting,
  resetDesktopCodeGraphModeSetting,
  resetDesktopTaskNormalizerEnabledSetting,
  writeDesktopAutoApproveEnabledSetting,
  writeDesktopCodeGraphModeSetting,
  writeDesktopTaskNormalizerEnabledSetting,
} from '../../src/core/config/desktop_settings_config.js';

function makeGlobalConfigPath(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-core-desktop-settings-'));
  return { dir, file: path.join(dir, 'config.yaml') };
}

function readYaml(file: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('core desktop remembered settings in global config', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  test('desktop.codegraph.mode defaults to detect-only when global config is missing', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);

    const setting = readDesktopCodeGraphModeSetting({ globalConfigPath: file });

    expect(setting).toMatchObject({
      mode: 'detect-only',
      default: 'detect-only',
      source: 'default',
      globalConfigPath: file,
      globalConfigExists: false,
      warnings: [],
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('desktop.codegraph.mode set use-existing persists under desktop namespace', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({ version: 1, defaults: { codegraph: { transport: 'mcp' } } }), 'utf8');

    const written = writeDesktopCodeGraphModeSetting({ globalConfigPath: file, mode: 'use-existing' });

    expect(written).toMatchObject({ mode: 'use-existing', source: 'global', artifactPath: file });
    expect(readYaml(file)).toMatchObject({
      defaults: { codegraph: { transport: 'mcp' } },
      desktop: { codegraph: { mode: 'use-existing' } },
    });
  });

  test('desktop.codegraph.mode reset returns detect-only and removes only the desktop mode', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({
      version: 1,
      defaults: { codegraph: { transport: 'auto' } },
      desktop: { codegraph: { mode: 'use-existing' } },
    }), 'utf8');

    const reset = resetDesktopCodeGraphModeSetting({ globalConfigPath: file });
    const reread = readDesktopCodeGraphModeSetting({ globalConfigPath: file });

    expect(reset).toMatchObject({ mode: 'detect-only', source: 'default' });
    expect(reread).toMatchObject({ mode: 'detect-only', source: 'default' });
    const saved = readYaml(file);
    expect(saved).toMatchObject({ defaults: { codegraph: { transport: 'auto' } } });
    expect(saved).not.toMatchObject({ desktop: { codegraph: { mode: 'use-existing' } } });
  });

  test('invalid stored desktop.codegraph.mode falls back with warning and invalid write rejects without mutating', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({ version: 1, desktop: { codegraph: { mode: 'enabled' } } }), 'utf8');

    const setting = readDesktopCodeGraphModeSetting({ globalConfigPath: file });
    const before = fs.readFileSync(file, 'utf8');

    expect(setting.mode).toBe('detect-only');
    expect(setting.source).toBe('default');
    expect(setting.warnings.join('\n')).toContain('INVALID_DESKTOP_CODEGRAPH_MODE_CONFIG');
    expect(() => writeDesktopCodeGraphModeSetting({ globalConfigPath: file, mode: 'enabled' as never })).toThrow(/INVALID_DESKTOP_CODEGRAPH_MODE/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('desktop.task_normalizer.enabled defaults false, persists true, and resets false', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);

    expect(readDesktopTaskNormalizerEnabledSetting({ globalConfigPath: file })).toMatchObject({ enabled: false, source: 'default' });

    const written = writeDesktopTaskNormalizerEnabledSetting({ globalConfigPath: file, enabled: true });
    expect(written).toMatchObject({ enabled: true, source: 'global', artifactPath: file });
    expect(readYaml(file)).toMatchObject({ desktop: { task_normalizer: { enabled: true } } });

    const reset = resetDesktopTaskNormalizerEnabledSetting({ globalConfigPath: file });
    expect(reset).toMatchObject({ enabled: false, source: 'default' });
    expect(readDesktopTaskNormalizerEnabledSetting({ globalConfigPath: file })).toMatchObject({ enabled: false, source: 'default' });
  });

  test('desktop.task_normalizer.enabled invalid stored value falls back and invalid write rejects', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({ version: 1, desktop: { task_normalizer: { enabled: 'yes' } } }), 'utf8');

    const before = fs.readFileSync(file, 'utf8');
    const setting = readDesktopTaskNormalizerEnabledSetting({ globalConfigPath: file });

    expect(setting.enabled).toBe(false);
    expect(setting.warnings.join('\n')).toContain('INVALID_DESKTOP_TASK_NORMALIZER_ENABLED_CONFIG');
    expect(() => writeDesktopTaskNormalizerEnabledSetting({ globalConfigPath: file, enabled: 'true' as never })).toThrow(/INVALID_DESKTOP_TASK_NORMALIZER_ENABLED/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('desktop.auto_approve.enabled defaults false, persists true, and resets false', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);

    expect(readDesktopAutoApproveEnabledSetting({ globalConfigPath: file })).toMatchObject({ enabled: false, source: 'default' });

    const written = writeDesktopAutoApproveEnabledSetting({ globalConfigPath: file, enabled: true });
    expect(written).toMatchObject({ enabled: true, source: 'global', artifactPath: file });
    expect(readYaml(file)).toMatchObject({ desktop: { auto_approve: { enabled: true } } });

    const reset = resetDesktopAutoApproveEnabledSetting({ globalConfigPath: file });
    expect(reset).toMatchObject({ enabled: false, source: 'default' });
    expect(readDesktopAutoApproveEnabledSetting({ globalConfigPath: file })).toMatchObject({ enabled: false, source: 'default' });
  });

  test('desktop.auto_approve.enabled invalid stored value falls back and invalid write rejects', () => {
    const { dir, file } = makeGlobalConfigPath();
    cleanup.push(dir);
    fs.writeFileSync(file, YAML.stringify({ version: 1, desktop: { auto_approve: { enabled: 1 } } }), 'utf8');

    const before = fs.readFileSync(file, 'utf8');
    const setting = readDesktopAutoApproveEnabledSetting({ globalConfigPath: file });

    expect(setting.enabled).toBe(false);
    expect(setting.warnings.join('\n')).toContain('INVALID_DESKTOP_AUTO_APPROVE_ENABLED_CONFIG');
    expect(() => writeDesktopAutoApproveEnabledSetting({ globalConfigPath: file, enabled: 'yes' as never })).toThrow(/INVALID_DESKTOP_AUTO_APPROVE_ENABLED/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
