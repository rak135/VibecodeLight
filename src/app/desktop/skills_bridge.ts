import { discoverRepoSkills } from '../../core/skills/selected_manifest.js';

export interface IpcMainLike {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
}

export interface DesktopSkillsBridgeOptions {
  getRepoPath: () => string;
}

export interface DesktopSkillIpc {
  id: string;
  title: string;
  summary: string;
  source_path: string;
}

export interface DesktopSkillsListResultIpc {
  ok: boolean;
  skills?: DesktopSkillIpc[];
  error?: { code: string; message: string };
}

export function registerDesktopSkillsIpcHandlers(
  ipcMain: IpcMainLike,
  options: DesktopSkillsBridgeOptions,
): void {
  ipcMain.handle('skills:listAvailable', () => listAvailableSkills(options));
}

export function listAvailableSkills(
  options: DesktopSkillsBridgeOptions,
): DesktopSkillsListResultIpc {
  const repoRoot = options.getRepoPath();
  if (!repoRoot) {
    return {
      ok: false,
      error: { code: 'REPO_ROOT_REQUIRED', message: 'no repository root resolved' },
    };
  }
  try {
    const skills = discoverRepoSkills(repoRoot).map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.summary,
      source_path: s.source_path,
    }));
    return { ok: true, skills };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'SKILLS_LIST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
