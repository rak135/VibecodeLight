import os from 'os';
import path from 'path';

import {
  resolveUserProfileDir,
  getGlobalConfigPaths,
  getLocalConfigPath,
} from '../../../src/core/config/user_profile.js';

describe('user profile resolution', () => {
  test('resolves global directory from LOCALAPPDATA', () => {
    const dir = resolveUserProfileDir({ LOCALAPPDATA: 'D:\\Custom\\Local' });
    expect(dir).toBe(path.join('D:\\Custom\\Local', 'vibecodelight'));
  });

  test('falls back to homedir/AppData/Local when LOCALAPPDATA is absent', () => {
    const dir = resolveUserProfileDir({});
    expect(dir).toBe(path.join(os.homedir(), 'AppData', 'Local', 'vibecodelight'));
  });

  test('resolves global config path', () => {
    const paths = getGlobalConfigPaths({ LOCALAPPDATA: 'D:\\Custom\\Local' });
    expect(paths.config).toBe(path.join('D:\\Custom\\Local', 'vibecodelight', 'config.yaml'));
  });

  test('resolves global env path', () => {
    const paths = getGlobalConfigPaths({ LOCALAPPDATA: 'D:\\Custom\\Local' });
    expect(paths.env).toBe(path.join('D:\\Custom\\Local', 'vibecodelight', '.env'));
  });

  test('resolves local workspace config path under .vibecode/config.yaml', () => {
    const local = getLocalConfigPath('C:\\repo');
    expect(local).toBe(path.join('C:\\repo', '.vibecode', 'config.yaml'));
  });

  test('does not hardcode a user name in resolution', () => {
    const dir = resolveUserProfileDir({ LOCALAPPDATA: 'X:\\nobody\\Local' });
    expect(dir).not.toMatch(/Martin/i);
  });

  test('resolves to XDG_CONFIG_HOME/vibecodelight on linux when XDG_CONFIG_HOME is set', () => {
    const dir = resolveUserProfileDir(
      { XDG_CONFIG_HOME: '/home/user/.config' },
      'linux',
    );
    expect(dir).toBe(path.join('/home/user/.config', 'vibecodelight'));
  });

  test('falls back to ~/.config/vibecodelight on linux when XDG_CONFIG_HOME is not set', () => {
    const dir = resolveUserProfileDir({ LOCALAPPDATA: undefined }, 'linux');
    expect(dir).toBe(path.join(os.homedir(), '.config', 'vibecodelight'));
  });

  test('resolves to ~/Library/Application Support/vibecodelight on darwin', () => {
    const dir = resolveUserProfileDir({}, 'darwin');
    expect(dir).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'vibecodelight'));
  });

  test('darwin XDG_CONFIG_HOME is ignored in favor of ~/Library/Application Support', () => {
    const dir = resolveUserProfileDir(
      { XDG_CONFIG_HOME: '/custom/xdg' },
      'darwin',
    );
    expect(dir).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'vibecodelight'));
  });

  test('windows path is unchanged', () => {
    const dir = resolveUserProfileDir({ LOCALAPPDATA: 'D:\\Custom\\Local' }, 'win32');
    expect(dir).toBe(path.join('D:\\Custom\\Local', 'vibecodelight'));
  });

  test('windows fallback is unchanged', () => {
    const dir = resolveUserProfileDir({}, 'win32');
    expect(dir).toBe(path.join(os.homedir(), 'AppData', 'Local', 'vibecodelight'));
  });
});
