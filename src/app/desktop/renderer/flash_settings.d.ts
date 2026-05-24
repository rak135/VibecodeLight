// Type declarations for the plain-JS renderer presenter/controller module.
// Input shapes are intentionally permissive (`unknown`) because the renderer
// only forwards the safe, secret-free payloads returned by the preload `config`
// bridge; the return shapes are the view-models the GUI renders.

export type FlashMode = 'mock' | 'live';

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
    generatePreview(task: string): Promise<unknown>;
    generatePreviewLive(task: string, provider?: string, model?: string): Promise<unknown>;
  };
  mode: FlashMode | string | undefined;
  task: string;
  provider: string;
  model: string;
  providerList: ProviderListItem[];
}

export interface ComposerPreviewOutcome {
  mode: FlashMode;
  flashMode: FlashMode;
  blocked: boolean;
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

export interface FlashSettingsConfigApi {
  show(): Promise<{ ok: boolean; resolution: unknown }>;
  providers(): Promise<{ ok: boolean; providers: unknown[] }>;
  syncFromGlobal(): Promise<{ ok: boolean; error?: { code: string; message: string; details?: string[] } }>;
  openDir(): Promise<{ ok: boolean; error?: string }>;
}

export interface FlashSettingsController {
  refresh(): Promise<void>;
  setMode(mode: FlashMode | string | undefined): FlashMode;
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
  runComposerPreview(opts: ComposerPreviewOptions): Promise<ComposerPreviewOutcome>;
  modelsForProvider(providers: unknown, providerId: string): ProviderModelView[];
  safeDiagnostic(errLike: unknown): string;
  createController(opts: { api: FlashSettingsConfigApi; view: FlashSettingsView }): FlashSettingsController;
}

declare const FlashSettings: FlashSettingsModule;
export default FlashSettings;
