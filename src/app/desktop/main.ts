import * as path from 'path';

import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';

import { getConfigPaths } from '../../core/config/index.js';
import { resolveDesktopRepo, RepoResolveResult } from './repo_resolver.js';
import { registerDesktopArtifactIpcHandlers } from './artifact_bridge.js';
import { registerDesktopComposerIpcHandlers } from './composer_bridge.js';
import { registerDesktopConfigIpcHandlers } from './config_bridge.js';
import { registerDesktopRunsIpcHandlers } from './runs_bridge.js';
import { registerDesktopTerminalIpcHandlers } from './terminal_bridge.js';
import { registerCodeGraphBridge } from './codegraph_bridge.js';
import { registerDesktopCoordinationIpcHandlers } from './coordination_bridge.js';
import { registerDesktopObservabilityIpcHandlers } from './observability_bridge.js';
import { registerDesktopMcpIpcHandlers } from './mcp_bridge.js';
import { registerDesktopCodebaseMapIpcHandlers } from './codebase_map_bridge.js';
import { registerDesktopSkillsIpcHandlers } from './skills_bridge.js';

// Defensive: the embedded xterm.js terminal is repainted by Chromium's GPU
// compositor, whose behaviour varies across Windows GPU/driver combinations.
// The actual fix for the stale/overlapping terminal glyphs was the renderer
// surface/geometry change (unpadded host + integer font metrics + canvas
// renderer); this line is a belt-and-suspenders measure that keeps terminal
// rasterization on the CPU so the result does not depend on the local GPU
// driver. Must run before app `ready`.
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | undefined;
let ipcRegistered = false;

function parseRepoArg(): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--repo');
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
}

const repoResolution: RepoResolveResult = resolveDesktopRepo({
  repoArg: parseRepoArg(),
  cwd: process.cwd(),
});

function getRepoPath(): string {
  if (repoResolution.ok) return repoResolution.repoRoot;
  return '';
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'VibecodeLight',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!ipcRegistered) {
    const terminalService = registerDesktopTerminalIpcHandlers(ipcMain, {
      getWebContents: () => mainWindow?.webContents,
      getRepoPath,
    });
    registerDesktopComposerIpcHandlers(ipcMain, {
      getRepoPath,
      getTerminalService: () => terminalService,
    });
    registerDesktopConfigIpcHandlers(ipcMain, { getRepoPath });
    registerDesktopRunsIpcHandlers(ipcMain, { getRepoPath });
    registerDesktopArtifactIpcHandlers(ipcMain, { getRepoPath });
    registerDesktopCoordinationIpcHandlers(ipcMain, { getRepoPath });
    registerDesktopObservabilityIpcHandlers(ipcMain, { getRepoPath });
    registerDesktopMcpIpcHandlers(ipcMain, { getRepoPath });
    registerDesktopCodebaseMapIpcHandlers(ipcMain, { getRepoPath });
    registerCodeGraphBridge(ipcMain, {
      getRepoRoot: async () => {
        const root = getRepoPath();
        if (!root) throw new Error('No repository root resolved');
        return root;
      },
    });

    // Open the global config directory in the OS file explorer (no secrets read).
    ipcMain.handle('config:openDir', async () => {
      const { globalDir } = getConfigPaths(getRepoPath(), process.env);
      const result = await shell.openPath(globalDir);
      return { ok: result === '', error: result || undefined };
    });

    // Expose workspace info including repo root and any resolution error
    ipcMain.handle('workspace:getInfo', () => {
      if (repoResolution.ok) {
        return {
          repoPath: repoResolution.repoRoot,
          source: repoResolution.source,
          error: null,
        };
      }
      return {
        repoPath: '',
        source: null,
        error: repoResolution.error,
      };
    });

    registerDesktopSkillsIpcHandlers(ipcMain, { getRepoPath });

    ipcMain.handle('artifacts:copyToClipboard', (_event, text: string) => {
      clipboard.writeText(typeof text === 'string' ? text : '');
    });
    ipcMain.handle('artifacts:readClipboard', () => clipboard.readText());
    ipcMain.handle('artifacts:openPath', async (_event, p: string) => {
      if (typeof p !== 'string' || !p) return { ok: false, error: 'path required' };
      const result = await shell.openPath(p);
      return { ok: result === '', error: result || undefined };
    });

    ipcRegistered = true;
  }

  void mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error('failed to start VibecodeLight desktop shell', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
