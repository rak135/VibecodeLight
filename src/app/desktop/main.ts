import * as path from 'path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { resolveDesktopRepo, RepoResolveResult } from './repo_resolver.js';
import { registerDesktopComposerIpcHandlers } from './composer_bridge.js';
import { registerDesktopTerminalIpcHandlers } from './terminal_bridge.js';

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
