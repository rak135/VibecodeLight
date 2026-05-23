import { contextBridge, ipcRenderer } from 'electron';

export interface ContextSummaryIpc {
  relevant_files: string[];
  files_to_read_with_tools: string[];
  commands_to_run: string[];
  cautions: string[];
  selected_skills: Array<{ id: string; title: string }>;
}

export interface ComposerPreviewIpcResult {
  ok: boolean;
  run_id?: string;
  runDir?: string;
  finalPromptPath?: string;
  contextPackPath?: string;
  selectedSkillsPath?: string;
  finalPrompt?: string;
  context?: ContextSummaryIpc;
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

export interface ProviderModelSummaryIpc {
  id: string;
  label: string | null;
  role: string | null;
}

export interface ProviderSummaryIpc {
  id: string;
  label: string | null;
  type: string | null;
  baseUrl_host: string | null;
  api_key_env: string | null;
  has_api_key: boolean;
  origin: string;
  models: ProviderModelSummaryIpc[];
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
  provider_label: string | null;
  provider_type: string | null;
  model: string | null;
  model_label: string | null;
  baseUrl_host: string | null;
  api_key_env: string | null;
  api_key_source: string | null;
  has_api_key: boolean;
  source_map: Record<string, string>;
  providers: ProviderSummaryIpc[];
  warnings: string[];
}

export interface ConfigProvidersIpc {
  ok: boolean;
  providers: ProviderSummaryIpc[];
  active_provider: string | null;
  active_model: string | null;
  config_source: string;
  local_config_path: string;
  global_config_path: string;
  global_env_path: string;
}

export interface ConfigModelsIpc {
  ok: boolean;
  providers: Array<{ id: string; label: string | null; has_api_key: boolean; api_key_env: string | null; models: ProviderModelSummaryIpc[] }>;
  active_provider: string | null;
  active_model: string | null;
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

export interface RunInfoIpc {
  run_id: string;
  task: string;
  repo_root: string;
  created_at: string;
  runDir: string;
  artifacts: {
    user_prompt?: string;
    run_manifest?: string;
    scanner_config?: string;
    flash_input?: string;
    flash_output?: string;
    context_pack?: string;
    selected_skills?: string;
    final_prompt?: string;
    send_metadata?: string;
  };
  has_final_prompt: boolean;
  has_send_metadata: boolean;
}

export interface RunsListIpc {
  ok: boolean;
  runs: RunInfoIpc[];
  error?: { code: string; message: string; details: string[] };
}

export interface RunsShowIpc {
  ok: boolean;
  run?: RunInfoIpc;
  error?: { code: string; message: string; path?: string; details: string[] };
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
  runs: {
    list(): Promise<RunsListIpc>;
    show(runId: string): Promise<RunsShowIpc>;
  };
  config: {
    getPaths(): Promise<ConfigPathsIpc>;
    show(): Promise<{ ok: boolean; resolution: ConfigResolutionIpc }>;
    providers(): Promise<ConfigProvidersIpc>;
    models(): Promise<ConfigModelsIpc>;
    initLocal(): Promise<{ ok: boolean; localConfigPath: string; created: boolean; createdFromGlobal: boolean; source: string }>;
    syncFromGlobal(): Promise<ConfigSyncIpc>;
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
    runs: {
      list() {
        return ipcRenderer.invoke('runs:list') as Promise<RunsListIpc>;
      },
      show(runId: string) {
        return ipcRenderer.invoke('runs:show', runId) as Promise<RunsShowIpc>;
      },
    },
    config: {
      getPaths() {
        return ipcRenderer.invoke('config:getPaths') as Promise<ConfigPathsIpc>;
      },
      show() {
        return ipcRenderer.invoke('config:show') as Promise<{ ok: boolean; resolution: ConfigResolutionIpc }>;
      },
      providers() {
        return ipcRenderer.invoke('config:providers') as Promise<ConfigProvidersIpc>;
      },
      models() {
        return ipcRenderer.invoke('config:models') as Promise<ConfigModelsIpc>;
      },
      initLocal() {
        return ipcRenderer.invoke('config:initLocal') as Promise<{ ok: boolean; localConfigPath: string; created: boolean; createdFromGlobal: boolean; source: string }>;
      },
      syncFromGlobal() {
        return ipcRenderer.invoke('config:syncFromGlobal') as Promise<ConfigSyncIpc>;
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
