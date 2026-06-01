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
  flashOutputPath?: string;
  flashOutputContent?: string;
  providerErrorPath?: string;
  artifacts?: string[];
  context?: ContextSummaryIpc;
  taskIntent?: unknown;
  taskNormalizerEnabled?: boolean;
  taskNormalizerOk?: boolean;
  taskNormalizerLanguage?: string;
  taskIntentPath?: string;
  /** Optional CodeGraph detect-only status for this run (informational only). */
  codegraph?: CodeGraphStatusIpc;
  /** CodeGraph transport requested for this run (cli/mcp/auto). */
  codegraphTransportRequested?: CodeGraphTransportIpc;
  /** CodeGraph transport that actually built the context, or 'none'. */
  codegraphTransportUsed?: CodeGraphTransportIpc | 'none';
  /** True when the run started on MCP and fell back to the CLI transport. */
  codegraphFallbackUsed?: boolean;
  /** Human-readable reason for the MCP→CLI fallback. */
  codegraphFallbackReason?: string;
  terminalSend?: 'not_sent';
  /** The flash mode used: mock or live. */
  flash_mode?: 'mock' | 'live';
  warnings?: string[];
  error?: { code: string; message: string; path?: string; details: string[] };
}

export type PipelineProgressEventStatus = 'started' | 'completed' | 'skipped' | 'warning' | 'failed';

export interface PipelineProgressEvent {
  phase: string;
  status?: PipelineProgressEventStatus;
  label?: string;
  message: string;
  detail?: string;
  timestamp?: string;
  duration_ms?: number;
  run_id?: string;
  provider_id?: string;
  model_id?: string;
  elapsed_ms?: number;
  artifact_path?: string;
  chunk?: string;
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
    auto_approve: boolean;
    byte_count: number;
    char_count: number;
    bytes: number;
    lines: number;
    content_sha256: string;
    sent_payload_sha256: string;
    newline_appended: boolean;
    transfer_mode: 'bracketed_paste_chunked';
    chunk_count: number;
    chunk_size: number;
    enter_sent_after_paste: boolean;
    bracketed_paste: true;
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

export interface ConfigRememberLiveSelectionIpc {
  ok: boolean;
  provider: string;
  model: string;
  localConfigPath?: string;
  error?: { code: string; message: string; details?: string[] };
}

export interface CodeGraphTransportSettingIpc {
  ok: boolean;
  transport?: CodeGraphTransportIpc;
  default?: CodeGraphTransportIpc;
  source?: 'global' | 'default';
  global_config_path?: string;
  global_config_exists?: boolean;
  warnings?: string[];
  artifactPath?: string;
  error?: { code: string; message: string; details: string[] };
}

export interface DesktopCodeGraphModeSettingIpc {
  ok: boolean;
  mode?: CodeGraphContextModeIpc;
  default?: CodeGraphContextModeIpc;
  source?: 'global' | 'default';
  global_config_path?: string;
  global_config_exists?: boolean;
  warnings?: string[];
  artifactPath?: string;
  error?: { code: string; message: string; details: string[] };
}

export interface DesktopBooleanSettingIpc {
  ok: boolean;
  enabled?: boolean;
  default?: boolean;
  source?: 'global' | 'default';
  global_config_path?: string;
  global_config_exists?: boolean;
  warnings?: string[];
  artifactPath?: string;
  error?: { code: string; message: string; details: string[] };
}

/**
 * Mirror of the core `CodeGraphStatus` shape (detect-only, informational). The
 * renderer reads this from `runs:show`; it never parses external_tools.json or
 * runs detection itself.
 */
export interface CodeGraphStatusIpc {
  state: 'not-installed' | 'installed-not-initialized' | 'ready' | 'unknown';
  label: string;
  mode: string | null;
  detail: string;
  warnings: string[];
  usageNote: string;
  usedForContext?: boolean;
  usageReason?: string;
  contextArtifact?: string;
  repoAtlasGenerated?: boolean;
  repoAtlasReason?: string;
  repoAtlasNote?: string;
  repoAtlasArtifact?: string;
  repoAtlasJsonArtifact?: string;
}

export type CodeGraphContextModeIpc = 'detect-only' | 'use-existing';
export type CodeGraphTransportIpc = 'cli' | 'mcp' | 'auto';
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
    codegraph_usage?: string;
    codegraph_context?: string;
    /** Canonical CodeGraph-derived Repo Atlas markdown. */
    codegraph_repo_atlas?: string;
    /** Canonical CodeGraph-derived Repo Atlas JSON. */
    codegraph_repo_atlas_json?: string;
    /** Legacy compat copy of the CodeGraph-derived Repo Atlas markdown. */
    repo_atlas?: string;
    /** Legacy compat copy of the CodeGraph-derived Repo Atlas JSON. */
    repo_atlas_json?: string;
  };
  has_final_prompt: boolean;
  has_send_metadata: boolean;
  codegraph: CodeGraphStatusIpc;
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

/** IPC result shapes for CodeGraph action channels (Phase 1.6). */
export interface CodeGraphStatusIpcResult {
  ok: boolean;
  available: boolean;
  initialized: boolean;
  version?: string;
  warnings: string[];
  error?: { message: string };
}

export interface CodeGraphActionIpcResult {
  ok: boolean;
  stdoutSummary?: string;
  stderrSummary?: string;
  error?: { message: string; details?: string };
}

export interface VibecodePreloadApi {
  terminal: {
    start(repoPath: string, cols: number, rows: number): Promise<{ pid: number; cwd: string; shell: string; sessionId: string }>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    close(sessionId?: string): Promise<void>;
    list(): Promise<Array<{ sessionId: string; pid: number; cwd: string; shell: string }>>;
    onData(callback: (sessionId: string, data: string) => void): void;
    onExit(callback: (sessionId: string, code: number | undefined) => void): void;
  };
  workspace: {
    getInfo(): Promise<{
      repoPath: string;
      source?: string | null;
      error?: { code: string; message: string; resolvedPath?: string; details: string[] } | null;
    }>;
  };
  composer: {
    generatePreview(task: string, codegraphMode?: CodeGraphContextModeIpc, taskNormalizerEnabled?: boolean, codegraphTransport?: CodeGraphTransportIpc): Promise<ComposerPreviewIpcResult>;
    generatePreviewLive(task: string, flashProvider?: string, flashModel?: string, codegraphMode?: CodeGraphContextModeIpc, taskNormalizerEnabled?: boolean, codegraphTransport?: CodeGraphTransportIpc): Promise<ComposerPreviewIpcResult>;
    sendPreview(runId: string, targetSessionId?: string, autoApprove?: boolean): Promise<ComposerSendIpcResult>;
    onProgress(callback: (event: PipelineProgressEvent) => void): () => void;
  };
  runs: {
    list(): Promise<RunsListIpc>;
    show(runId: string): Promise<RunsShowIpc>;
  };
  config: {
    getCodeGraphTransportSetting(): Promise<CodeGraphTransportSettingIpc>;
    setCodeGraphTransportSetting(transport: CodeGraphTransportIpc): Promise<CodeGraphTransportSettingIpc>;
    resetCodeGraphTransportSetting(): Promise<CodeGraphTransportSettingIpc>;
    getDesktopCodeGraphModeSetting(): Promise<DesktopCodeGraphModeSettingIpc>;
    setDesktopCodeGraphModeSetting(mode: CodeGraphContextModeIpc): Promise<DesktopCodeGraphModeSettingIpc>;
    resetDesktopCodeGraphModeSetting(): Promise<DesktopCodeGraphModeSettingIpc>;
    getDesktopTaskNormalizerEnabledSetting(): Promise<DesktopBooleanSettingIpc>;
    setDesktopTaskNormalizerEnabledSetting(enabled: boolean): Promise<DesktopBooleanSettingIpc>;
    resetDesktopTaskNormalizerEnabledSetting(): Promise<DesktopBooleanSettingIpc>;
    getDesktopAutoApproveEnabledSetting(): Promise<DesktopBooleanSettingIpc>;
    setDesktopAutoApproveEnabledSetting(enabled: boolean): Promise<DesktopBooleanSettingIpc>;
    resetDesktopAutoApproveEnabledSetting(): Promise<DesktopBooleanSettingIpc>;
    getPaths(): Promise<ConfigPathsIpc>;
    show(): Promise<{ ok: boolean; resolution: ConfigResolutionIpc }>;
    providers(): Promise<ConfigProvidersIpc>;
    models(): Promise<ConfigModelsIpc>;
    initLocal(): Promise<{ ok: boolean; localConfigPath: string; created: boolean; createdFromGlobal: boolean; source: string }>;
    rememberLiveSelection(provider: string, model: string): Promise<ConfigRememberLiveSelectionIpc>;
    syncFromGlobal(): Promise<ConfigSyncIpc>;
    openDir(): Promise<{ ok: boolean; error?: string }>;
  };
  artifacts: {
    copyToClipboard(text: string): void;
    readClipboard(): Promise<string>;
    openPath(p: string): Promise<{ ok: boolean; error?: string }>;
    readRunArtifact(runId: string, relativePath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  };
  codegraph: {
    status(): Promise<CodeGraphStatusIpcResult>;
    init(): Promise<CodeGraphActionIpcResult>;
    sync(): Promise<CodeGraphActionIpcResult>;
    reindex(): Promise<CodeGraphActionIpcResult>;
  };
}

export function createVibecodeApi(): VibecodePreloadApi {
  return {
    terminal: {
      start(repoPath: string, cols: number, rows: number) {
        return ipcRenderer.invoke('terminal:start', repoPath, cols, rows) as Promise<{ pid: number; cwd: string; shell: string; sessionId: string }>;
      },
      write(sessionId: string, data: string) {
        ipcRenderer.send('terminal:input', sessionId, data);
      },
      resize(sessionId: string, cols: number, rows: number) {
        ipcRenderer.send('terminal:resize', sessionId, cols, rows);
      },
      close(sessionId?: string) {
        return ipcRenderer.invoke('terminal:close', sessionId) as Promise<void>;
      },
      list() {
        return ipcRenderer.invoke('terminal:list') as Promise<Array<{ sessionId: string; pid: number; cwd: string; shell: string }>>;
      },
      onData(callback: (sessionId: string, data: string) => void) {
        ipcRenderer.on('terminal:data', (_event, sessionId: string, data: string) => callback(sessionId, data));
      },
      onExit(callback: (sessionId: string, code: number | undefined) => void) {
        ipcRenderer.on('terminal:exit', (_event, sessionId: string, code: number | undefined) => callback(sessionId, code));
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
      generatePreview(task: string, codegraphMode?: CodeGraphContextModeIpc, taskNormalizerEnabled?: boolean, codegraphTransport?: CodeGraphTransportIpc) {
        return ipcRenderer.invoke(
          'composer:generatePreview',
          task,
          'mock',
          undefined,
          undefined,
          codegraphMode,
          taskNormalizerEnabled === true,
          codegraphTransport,
        ) as Promise<ComposerPreviewIpcResult>;
      },
      generatePreviewLive(task: string, flashProvider?: string, flashModel?: string, codegraphMode?: CodeGraphContextModeIpc, taskNormalizerEnabled?: boolean, codegraphTransport?: CodeGraphTransportIpc) {
        return ipcRenderer.invoke(
          'composer:generatePreview',
          task,
          'live',
          flashProvider,
          flashModel,
          codegraphMode,
          taskNormalizerEnabled === true,
          codegraphTransport,
        ) as Promise<ComposerPreviewIpcResult>;
      },
      sendPreview(runId: string, targetSessionId?: string, autoApprove?: boolean) {
        return ipcRenderer.invoke('composer:sendPreview', runId, targetSessionId, Boolean(autoApprove)) as Promise<ComposerSendIpcResult>;
      },
      onProgress(callback: (event: PipelineProgressEvent) => void) {
        const listener = (_event: unknown, progressEvent: PipelineProgressEvent) => callback(progressEvent);
        ipcRenderer.on('composer:progress', listener);
        return () => ipcRenderer.removeListener('composer:progress', listener);
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
      getCodeGraphTransportSetting() {
        return ipcRenderer.invoke('config:getCodeGraphTransportSetting') as Promise<CodeGraphTransportSettingIpc>;
      },
      setCodeGraphTransportSetting(transport: CodeGraphTransportIpc) {
        return ipcRenderer.invoke('config:setCodeGraphTransportSetting', transport) as Promise<CodeGraphTransportSettingIpc>;
      },
      resetCodeGraphTransportSetting() {
        return ipcRenderer.invoke('config:resetCodeGraphTransportSetting') as Promise<CodeGraphTransportSettingIpc>;
      },
      getDesktopCodeGraphModeSetting() {
        return ipcRenderer.invoke('config:getDesktopCodeGraphModeSetting') as Promise<DesktopCodeGraphModeSettingIpc>;
      },
      setDesktopCodeGraphModeSetting(mode: CodeGraphContextModeIpc) {
        return ipcRenderer.invoke('config:setDesktopCodeGraphModeSetting', mode) as Promise<DesktopCodeGraphModeSettingIpc>;
      },
      resetDesktopCodeGraphModeSetting() {
        return ipcRenderer.invoke('config:resetDesktopCodeGraphModeSetting') as Promise<DesktopCodeGraphModeSettingIpc>;
      },
      getDesktopTaskNormalizerEnabledSetting() {
        return ipcRenderer.invoke('config:getDesktopTaskNormalizerEnabledSetting') as Promise<DesktopBooleanSettingIpc>;
      },
      setDesktopTaskNormalizerEnabledSetting(enabled: boolean) {
        return ipcRenderer.invoke('config:setDesktopTaskNormalizerEnabledSetting', enabled) as Promise<DesktopBooleanSettingIpc>;
      },
      resetDesktopTaskNormalizerEnabledSetting() {
        return ipcRenderer.invoke('config:resetDesktopTaskNormalizerEnabledSetting') as Promise<DesktopBooleanSettingIpc>;
      },
      getDesktopAutoApproveEnabledSetting() {
        return ipcRenderer.invoke('config:getDesktopAutoApproveEnabledSetting') as Promise<DesktopBooleanSettingIpc>;
      },
      setDesktopAutoApproveEnabledSetting(enabled: boolean) {
        return ipcRenderer.invoke('config:setDesktopAutoApproveEnabledSetting', enabled) as Promise<DesktopBooleanSettingIpc>;
      },
      resetDesktopAutoApproveEnabledSetting() {
        return ipcRenderer.invoke('config:resetDesktopAutoApproveEnabledSetting') as Promise<DesktopBooleanSettingIpc>;
      },
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
      rememberLiveSelection(provider: string, model: string) {
        return ipcRenderer.invoke('config:rememberLiveSelection', provider, model) as Promise<ConfigRememberLiveSelectionIpc>;
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
      readClipboard() {
        return ipcRenderer.invoke('artifacts:readClipboard') as Promise<string>;
      },
      openPath(p: string) {
        return ipcRenderer.invoke('artifacts:openPath', p) as Promise<{ ok: boolean; error?: string }>;
      },
      readRunArtifact(runId: string, relativePath: string) {
        return ipcRenderer.invoke('artifacts:readRunArtifact', runId, relativePath) as Promise<{ ok: boolean; content?: string; error?: string }>;
      },
    },
    codegraph: {
      status() {
        return ipcRenderer.invoke('codegraph:status') as Promise<CodeGraphStatusIpcResult>;
      },
      init() {
        return ipcRenderer.invoke('codegraph:init') as Promise<CodeGraphActionIpcResult>;
      },
      sync() {
        return ipcRenderer.invoke('codegraph:sync') as Promise<CodeGraphActionIpcResult>;
      },
      reindex() {
        return ipcRenderer.invoke('codegraph:reindex') as Promise<CodeGraphActionIpcResult>;
      },
    },
  };
}

contextBridge.exposeInMainWorld('vibecodeAPI', createVibecodeApi());
