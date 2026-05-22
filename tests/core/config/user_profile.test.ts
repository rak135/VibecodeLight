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
});
