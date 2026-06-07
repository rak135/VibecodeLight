import os from 'os';
import path from 'path';

export interface GlobalConfigPaths {
  /** The global user profile directory: %LOCALAPPDATA%\vibecodelight */
  dir: string;
  /** %LOCALAPPDATA%\vibecodelight\config.yaml */
  config: string;
  /** %LOCALAPPDATA%\vibecodelight\.env */
  env: string;
}

const PROFILE_DIR_NAME = 'vibecodelight';

/**
 * Resolve the global user profile directory.
 *
 * Windows primary: %LOCALAPPDATA%\vibecodelight
 * Fallback:        <homedir>\AppData\Local\vibecodelight
 *
 * Linux primary:   $XDG_CONFIG_HOME/vibecodelight
 * Fallback:        ~/.config/vibecodelight
 *
 * macOS:           ~/Library/Application Support/vibecodelight
 *
 * The implementation never hardcodes a user name; it reads LOCALAPPDATA/XDG_CONFIG_HOME
 * from the provided env (process.env by default) and falls back to os.homedir().
 */
export function resolveUserProfileDir(
  env: Record<string, string | undefined> = process.env,
  platform: typeof process.platform = process.platform,
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, PROFILE_DIR_NAME);
    }
    return path.join(os.homedir(), 'AppData', 'Local', PROFILE_DIR_NAME);
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', PROFILE_DIR_NAME);
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, PROFILE_DIR_NAME);
  }
  return path.join(os.homedir(), '.config', PROFILE_DIR_NAME);
}

/** Resolve the global config.yaml and .env paths under the user profile directory. */
export function getGlobalConfigPaths(env: Record<string, string | undefined> = process.env): GlobalConfigPaths {
  const dir = resolveUserProfileDir(env);
  return {
    dir,
    config: path.join(dir, 'config.yaml'),
    env: path.join(dir, '.env'),
  };
}

/** Resolve the per-repository local workspace config path: <repo>\.vibecode\config.yaml */
export function getLocalConfigPath(repoRoot: string): string {
  return path.join(repoRoot, '.vibecode', 'config.yaml');
}
