// Type declarations for the plain-JS renderer presenter/controller module.
// Input shapes are intentionally permissive (`unknown`) because the renderer
// only forwards the safe, secret-free payloads returned by the preload `config`
// bridge; the return shapes are the view-models the GUI renders.

export type FlashMode = 'mock' | 'live';
export type CodeGraphContextMode = 'detect-only' | 'use-existing';
export type CodeGraphTransport = 'cli' | 'mcp' | 'auto';

export interface FlashPill {
  available: boolean;
  mode: FlashMode;
  text: string;
  sourceText: string;
}

export interface SettingRow {
  label: string;
  value: string;
}

export interface ProviderModelView {
  id: string;
  label: string | null;
  role: string | null;
}

export interface ProviderListItem {
  id: string;
  label: string | null;
  hasApiKey: boolean;
  apiKeyEnv: string | null;
  models: ProviderModelView[];
}

export interface ComposerSelection {
  providers: Array<{ id: string; label: string | null }>;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultMode: FlashMode;
}

export interface ComposerModeState {
  mode: FlashMode;
  showLiveControls: boolean;
}

export interface ComposerKeyStatus {
  hasApiKey: boolean;
  apiKeyEnv: string | null;
  text: string;
}

export interface ComposerPreviewOptions {
  composer: {
    generatePreview(task: string, codegraphMode?: CodeGraphContextMode, taskNormalizerEnabled?: boolean, codegraphTransport?: CodeGraphTransport): Promise<unknown>;
    generatePreviewLive(task: string, provider?: string, model?: string, codegraphMode?: CodeGraphContextMode, taskNormalizerEnabled?: boolean, codegraphTransport?: CodeGraphTransport): Promise<unknown>;
  };
  mode: FlashMode | string | undefined;
  task: string;
  provider: string;
  model: string;
  providerList: ProviderListItem[];
  codegraphMode?: CodeGraphContextMode;
  codegraphTransport?: CodeGraphTransport | string;
  taskNormalizerEnabled?: boolean;
}

export interface ComposerPreviewOutcome {
  mode: FlashMode;
  flashMode: FlashMode;
  blocked: boolean;
  codegraphMode?: CodeGraphContextMode;
  codegraphTransport?: CodeGraphTransport;
  result?: unknown;
  diagnostic?: { code: string; message: string };
}

export interface FlashSettingsView {
  setPill(pill: FlashPill): void;
  setSettings(rows: SettingRow[]): void;
  setProviders(list: ProviderListItem[]): void;
  setComposer(selection: ComposerSelection): void;
  setStatus(text: string, kind?: string): void;
}

export interface CodeGraphTransportSettingResponse {
  ok: boolean;
  transport?: CodeGraphTransport;
  error?: { code: string; message: string; details?: string[] };
}

export interface DesktopCodeGraphModeSettingResponse {
  ok: boolean;
  mode?: CodeGraphContextMode;
  error?: { code: string; message: string; details?: string[] };
}

export interface DesktopBooleanSettingResponse {
  ok: boolean;
  enabled?: boolean;
  error?: { code: string; message: string; details?: string[] };
}

export interface FlashSettingsConfigApi {
  getCodeGraphTransportSetting?(): Promise<CodeGraphTransportSettingResponse>;
  setCodeGraphTransportSetting?(transport: CodeGraphTransport): Promise<CodeGraphTransportSettingResponse>;
  resetCodeGraphTransportSetting?(): Promise<CodeGraphTransportSettingResponse>;
  getDesktopCodeGraphModeSetting?(): Promise<DesktopCodeGraphModeSettingResponse>;
  setDesktopCodeGraphModeSetting?(mode: CodeGraphContextMode): Promise<DesktopCodeGraphModeSettingResponse>;
  resetDesktopCodeGraphModeSetting?(): Promise<DesktopCodeGraphModeSettingResponse>;
  getDesktopTaskNormalizerEnabledSetting?(): Promise<DesktopBooleanSettingResponse>;
  setDesktopTaskNormalizerEnabledSetting?(enabled: boolean): Promise<DesktopBooleanSettingResponse>;
  resetDesktopTaskNormalizerEnabledSetting?(): Promise<DesktopBooleanSettingResponse>;
  getDesktopAutoApproveEnabledSetting?(): Promise<DesktopBooleanSettingResponse>;
  setDesktopAutoApproveEnabledSetting?(enabled: boolean): Promise<DesktopBooleanSettingResponse>;
  resetDesktopAutoApproveEnabledSetting?(): Promise<DesktopBooleanSettingResponse>;
  show(): Promise<{ ok: boolean; resolution: unknown }>;
  providers(): Promise<{ ok: boolean; providers: unknown[] }>;
  rememberLiveSelection(provider: string, model: string): Promise<{ ok: boolean; provider: string; model: string; error?: { code: string; message: string; details?: string[] } }>;
  syncFromGlobal(): Promise<{ ok: boolean; error?: { code: string; message: string; details?: string[] } }>;
  openDir(): Promise<{ ok: boolean; error?: string }>;
}

export interface FlashSettingsController {
  refresh(): Promise<void>;
  setMode(mode: FlashMode | string | undefined): FlashMode;
  rememberLiveSelection(provider: string, model: string): Promise<void>;
  syncFromGlobal(): Promise<void>;
  openConfigFolder(): Promise<void>;
}

export interface FlashSettingsModule {
  buildPill(resolution: unknown, mode?: FlashMode | string): FlashPill;
  buildSettings(resolution: unknown): SettingRow[];
  buildProviderList(providers: unknown): ProviderListItem[];
  buildComposerSelection(resolution: unknown): ComposerSelection;
  composerModeState(mode: FlashMode | string | undefined): ComposerModeState;
  composerKeyStatus(providerList: ProviderListItem[], providerId: string): ComposerKeyStatus;
  readTaskNormalizerEnabled(storage: { getItem(key: string): string | null | undefined }): boolean;
  writeTaskNormalizerEnabled(storage: { setItem(key: string, value: string): void }, enabled: boolean): void;
  loadCodeGraphTransportSetting(configApi: Pick<FlashSettingsConfigApi, 'getCodeGraphTransportSetting'>, legacyStorage?: { getItem(key: string): string | null | undefined }): Promise<CodeGraphTransport>;
  writeCodeGraphTransportSetting(configApi: Pick<FlashSettingsConfigApi, 'setCodeGraphTransportSetting'>, transport: string | undefined, legacyStorage?: { setItem(key: string, value: string): void }): Promise<CodeGraphTransport>;
  loadDesktopCodeGraphModeSetting(configApi: Pick<FlashSettingsConfigApi, 'getDesktopCodeGraphModeSetting'>, legacyStorage?: { getItem(key: string): string | null | undefined }): Promise<CodeGraphContextMode>;
  writeDesktopCodeGraphModeSetting(configApi: Pick<FlashSettingsConfigApi, 'setDesktopCodeGraphModeSetting'>, mode: string | undefined): Promise<CodeGraphContextMode>;
  loadDesktopTaskNormalizerEnabledSetting(configApi: Pick<FlashSettingsConfigApi, 'getDesktopTaskNormalizerEnabledSetting'>, legacyStorage?: { getItem(key: string): string | null | undefined }): Promise<boolean>;
  writeDesktopTaskNormalizerEnabledSetting(configApi: Pick<FlashSettingsConfigApi, 'setDesktopTaskNormalizerEnabledSetting'>, enabled: boolean): Promise<boolean>;
  loadDesktopAutoApproveEnabledSetting(configApi: Pick<FlashSettingsConfigApi, 'getDesktopAutoApproveEnabledSetting'>): Promise<boolean>;
  writeDesktopAutoApproveEnabledSetting(configApi: Pick<FlashSettingsConfigApi, 'setDesktopAutoApproveEnabledSetting'>, enabled: boolean): Promise<boolean>;
  readCodeGraphTransport(storage?: { getItem(key: string): string | null | undefined }): CodeGraphTransport;
  writeCodeGraphTransport(storage: { setItem(key: string, value: string): void } | undefined, transport: string | undefined): CodeGraphTransport;
  normalizeCodeGraphTransport(value: unknown): CodeGraphTransport;
  CODEGRAPH_TRANSPORT_STORAGE_KEY: 'vibecode.codegraphTransport';
  DEFAULT_CODEGRAPH_TRANSPORT: 'cli';
  runComposerPreview(opts: ComposerPreviewOptions): Promise<ComposerPreviewOutcome>;
  modelsForProvider(providers: unknown, providerId: string): ProviderModelView[];
  safeDiagnostic(errLike: unknown): string;
  createController(opts: { api: FlashSettingsConfigApi; view: FlashSettingsView }): FlashSettingsController;
}

declare const FlashSettings: FlashSettingsModule;
export default FlashSettings;
