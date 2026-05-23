// Type declarations for the plain-JS renderer presenter/controller module.
// Input shapes are intentionally permissive (`unknown`) because the renderer
// only forwards the safe, secret-free payloads returned by the preload `config`
// bridge; the return shapes are the view-models the GUI renders.

export interface FlashPill {
  available: boolean;
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
  note: string;
  sourceText: string;
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
  syncToGlobal(): Promise<{ ok: boolean; error?: { code: string; message: string; details?: string[] } }>;
  openDir(): Promise<{ ok: boolean; error?: string }>;
}

export interface FlashSettingsController {
  refresh(): Promise<void>;
  syncFromGlobal(): Promise<void>;
  syncToGlobal(): Promise<void>;
  openConfigFolder(): Promise<void>;
}

export interface FlashSettingsModule {
  buildPill(resolution: unknown): FlashPill;
  buildSettings(resolution: unknown): SettingRow[];
  buildProviderList(providers: unknown): ProviderListItem[];
  buildComposerSelection(resolution: unknown): ComposerSelection;
  modelsForProvider(providers: unknown, providerId: string): ProviderModelView[];
  safeDiagnostic(errLike: unknown): string;
  createController(opts: { api: FlashSettingsConfigApi; view: FlashSettingsView }): FlashSettingsController;
}

declare const FlashSettings: FlashSettingsModule;
export default FlashSettings;
