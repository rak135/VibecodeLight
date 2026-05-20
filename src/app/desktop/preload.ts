import { contextBridge, ipcRenderer } from 'electron';

export interface ComposerPreviewIpcResult {
  ok: boolean;
  run_id?: string;
  runDir?: string;
  finalPromptPath?: string;
  contextPackPath?: string;
  selectedSkillsPath?: string;
  finalPrompt?: string;
  terminalSend?: 'not_sent';
  warnings?: string[];
  error?: { code: string; message: string; path?: string; details: string[] };
}

export interface VibecodePreloadApi {
  terminal: {
    start(repoPath: string, cols: number, rows: number): Promise<{ pid: number; cwd: string; shell: string }>;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    close(): Promise<void>;
    onData(callback: (data: string) => void): void;
    onExit(callback: (code: number | undefined) => void): void;
  };
  workspace: {
    getInfo(): Promise<{ repoPath: string }>;
  };
  composer: {
    generatePreview(task: string): Promise<ComposerPreviewIpcResult>;
  };
}

export function createVibecodeApi(): VibecodePreloadApi {
  return {
    terminal: {
      start(repoPath: string, cols: number, rows: number) {
        return ipcRenderer.invoke('terminal:start', repoPath, cols, rows) as Promise<{ pid: number; cwd: string; shell: string }>;
      },
      write(data: string) {
        ipcRenderer.send('terminal:input', data);
      },
      resize(cols: number, rows: number) {
        ipcRenderer.send('terminal:resize', cols, rows);
      },
      close() {
        return ipcRenderer.invoke('terminal:close') as Promise<void>;
      },
      onData(callback: (data: string) => void) {
        ipcRenderer.on('terminal:data', (_event, data: string) => callback(data));
      },
      onExit(callback: (code: number | undefined) => void) {
        ipcRenderer.on('terminal:exit', (_event, code: number | undefined) => callback(code));
      },
    },
    workspace: {
      getInfo() {
        return ipcRenderer.invoke('workspace:info') as Promise<{ repoPath: string }>;
      },
    },
    composer: {
      generatePreview(task: string) {
        return ipcRenderer.invoke('composer:generatePreview', task) as Promise<ComposerPreviewIpcResult>;
      },
    },
  };
}

contextBridge.exposeInMainWorld('vibecodeAPI', createVibecodeApi());
