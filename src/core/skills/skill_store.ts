import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Resolve the user-profile skills root.
 *
 * Override order:
 *   1. explicit override argument
 *   2. VIBECODE_USER_PROFILE env var (used by tests; points at a profile dir;
 *      skills live under <profile>/skills)
 *   3. VIBECODE_SKILLS_HOME env var (points directly at the skills root)
 *   4. platform default (%APPDATA%/VibecodeLight/skills on Windows,
 *      ~/.config/VibecodeLight/skills elsewhere)
 */
export function resolveUserSkillsRoot(override?: string): string {
  if (override && override.trim()) {
    return path.resolve(override);
  }
  const profileEnv = process.env.VIBECODE_USER_PROFILE;
  if (profileEnv && profileEnv.trim()) {
    return path.join(path.resolve(profileEnv), 'skills');
  }
  const skillsEnv = process.env.VIBECODE_SKILLS_HOME;
  if (skillsEnv && skillsEnv.trim()) {
    return path.resolve(skillsEnv);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      return path.join(appData, 'VibecodeLight', 'skills');
    }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'VibecodeLight', 'skills');
  }
  return path.join(os.homedir(), '.config', 'VibecodeLight', 'skills');
}

export function getProjectSkillsRoot(repoRoot: string): string {
  return path.join(repoRoot, 'SKILLS');
}

export function listSkillDirs(parentDir: string): string[] {
  if (!fs.existsSync(parentDir)) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
    .sort();
}
