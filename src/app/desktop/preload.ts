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

export interface ComposerSendIpcResult {
  ok: boolean;
  run_id?: string;
  runDir?: string;
  sentAt?: string;
  sendMetadataPath?: string;
  currentSendMetadataPath?: string;
  terminalSend?: 'sent';
  metadata?: {
    run_id: string;
    terminal_session_id: string;
    sent_file: string;
    sent_at: string;
    auto_approve: false;
    byte_count: number;
    char_count: number;
    content_sha256: string;
    sent_payload_sha256: string;
    newline_appended: boolean;
    terminal_cwd?: string;
  };
  error?: { code: string; message: string; path?: string; details: string[] };
}

export interface ConfigResolutionIpc {
  global_config_path: string;
  global_env_path: string;
  local_config_path: string;
  global_config_exists: boolean;
  global_env_exists: boolean;
  local_config_exists: boolean;
  local_config_created_from_global: boolean;
  selected_config_source: string;
  provider: string | null;
  model: string | null;
  baseUrl_host: string | null;
  has_api_key: boolean;
  source_map: Record<string, string>;
  warnings: string[];
}

export interface ConfigPathsIpc {
  ok: boolean;
  globalDir: string;
  globalConfig: string;
  globalEnv: string;
  localConfig: string;
}

export interface ConfigSyncIpc {
  ok: boolean;
  direction: 'from-global' | 'to-global';
  sourcePath: string;
  destinationPath: string;
  error?: { code: string; message: string; details: string[] };
}

export interface VibecodePreloadApi {
  terminal: {
    start(repoPath: string, cols: number, rows: number): Promise<{ pid: number; cwd: string; shell: string; sessionId: string }>;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    close(): Promise<void>;
    onData(callback: (data: string) => void): void;
    onExit(callback: (code: number | undefined) => void): void;
  };
  workspace: {
    getInfo(): Promise<{
      repoPath: string;
      source?: string | null;
      error?: { code: string; message: string; resolvedPath?: string; details: string[] } | null;
    }>;
  };
  composer: {
    generatePreview(task: string): Promise<ComposerPreviewIpcResult>;
    sendPreview(runId: string): Promise<ComposerSendIpcResult>;
  };
  config: {
    getPaths(): Promise<ConfigPathsIpc>;
    show(): Promise<{ ok: boolean; resolution: ConfigResolutionIpc }>;
    initLocal(): Promise<{ ok: boolean; localConfigPath: string; created: boolean; createdFromGlobal: boolean; source: string }>;
    syncFromGlobal(): Promise<ConfigSyncIpc>;
    syncToGlobal(): Promise<ConfigSyncIpc>;
    openDir(): Promise<{ ok: boolean; error?: string }>;
  };
  artifacts: {
    copyToClipboard(text: string): void;
    openPath(p: string): Promise<{ ok: boolean; error?: string }>;
  };
}

export function createVibecodeApi(): VibecodePreloadApi {
  return {
    terminal: {
      start(repoPath: string, cols: number, rows: number) {
        return ipcRenderer.invoke('terminal:start', repoPath, cols, rows) as Promise<{ pid: number; cwd: string; shell: string; sessionId: string }>;
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
        return ipcRenderer.invoke('workspace:getInfo') as Promise<{
          repoPath: string;
          source?: string | null;
          error?: { code: string; message: string; resolvedPath?: string; details: string[] } | null;
        }>;
      },
    },
    composer: {
      generatePreview(task: string) {
        return ipcRenderer.invoke('composer:generatePreview', task) as Promise<ComposerPreviewIpcResult>;
      },
      sendPreview(runId: string) {
        return ipcRenderer.invoke('composer:sendPreview', runId) as Promise<ComposerSendIpcResult>;
      },
    },
    config: {
      getPaths() {
        return ipcRenderer.invoke('config:getPaths') as Promise<ConfigPathsIpc>;
      },
      show() {
        return ipcRenderer.invoke('config:show') as Promise<{ ok: boolean; resolution: ConfigResolutionIpc }>;
      },
      initLocal() {
        return ipcRenderer.invoke('config:initLocal') as Promise<{ ok: boolean; localConfigPath: string; created: boolean; createdFromGlobal: boolean; source: string }>;
      },
      syncFromGlobal() {
        return ipcRenderer.invoke('config:syncFromGlobal') as Promise<ConfigSyncIpc>;
      },
      syncToGlobal() {
        return ipcRenderer.invoke('config:syncToGlobal') as Promise<ConfigSyncIpc>;
      },
      openDir() {
        return ipcRenderer.invoke('config:openDir') as Promise<{ ok: boolean; error?: string }>;
      },
    },
    artifacts: {
      copyToClipboard(text: string) {
        void ipcRenderer.invoke('artifacts:copyToClipboard', text);
      },
      openPath(p: string) {
        return ipcRenderer.invoke('artifacts:openPath', p) as Promise<{ ok: boolean; error?: string }>;
      },
    },
  };
}

contextBridge.exposeInMainWorld('vibecodeAPI', createVibecodeApi());
