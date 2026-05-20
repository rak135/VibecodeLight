import * as path from 'path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { registerDesktopComposerIpcHandlers } from './composer_bridge.js';
import { registerDesktopTerminalIpcHandlers } from './terminal_bridge.js';

let mainWindow: BrowserWindow | undefined;
let ipcRegistered = false;

function repoPath(): string {
  return process.env.VIBECODE_REPO || process.cwd();
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
    registerDesktopTerminalIpcHandlers(ipcMain, {
      getWebContents: () => mainWindow?.webContents,
      getRepoPath: repoPath,
    });
    registerDesktopComposerIpcHandlers(ipcMain, {
      getRepoPath: repoPath,
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
