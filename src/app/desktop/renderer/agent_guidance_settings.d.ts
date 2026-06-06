// Type declarations for the Agent Guidance settings presenter/controller.

export type AgentGuidanceToolGroup = 'workspace_orientation' | 'codegraph' | 'runs_artifacts';

export interface AgentGuidanceMcpTool {
  name: string;
  group: AgentGuidanceToolGroup;
  description: string;
}

export interface AgentGuidanceConfigView {
  schema_version: 1;
  enabled: boolean;
  apply_to_terminal_agents: boolean;
  scope: 'global';
  default_guidance: string;
  per_tool_notes: Record<string, string>;
  terminal_preflight: TerminalPreflightConfigView;
}

export type TerminalPreflightModeView = 'check_only' | 'auto_repair';

export interface TerminalPreflightConfigView {
  enabled: boolean;
  mode: TerminalPreflightModeView;
  supported_agents: { codex: boolean; claude: boolean };
  repair: { create_backup: boolean; require_valid_guidance_config: boolean };
}

export interface TerminalPreflightLastResultView {
  checked_at?: string;
  guidance_hash?: string;
  agents?: Array<{ agent: 'codex' | 'claude' | string; configured?: boolean; stale?: boolean; repaired?: boolean; error?: string }>;
}

export interface TerminalPreflightViewModel {
  title: 'Terminal Agent Preflight';
  copy: string;
  enabled: boolean;
  mode: TerminalPreflightModeView;
  modeOptions: Array<{ value: TerminalPreflightModeView; label: string }>;
  agentToggles: Array<{ agent: 'codex' | 'claude'; enabled: boolean }>;
  createBackup: boolean;
  statusRows: Array<{ label: string; value: string }>;
}

export interface AgentGuidanceReadResponse {
  ok: boolean;
  config: AgentGuidanceConfigView;
  source: 'default' | 'file';
  exists: boolean;
  configPath: string;
  warnings: string[];
  error?: { code: string; message: string; details?: string[] };
}

export interface AgentGuidanceWriteResponse {
  ok: boolean;
  config: AgentGuidanceConfigView;
  configPath: string;
  warnings: string[];
  error?: { code: string; message: string; details?: string[] };
}

export interface AgentGuidanceDefaultsResponse {
  ok: boolean;
  config: AgentGuidanceConfigView;
}

export interface AgentGuidanceConfigPathResponse {
  ok: boolean;
  configPath: string;
  filename: string;
}

export interface AgentGuidanceMcpToolsResponse {
  ok: boolean;
  tools: AgentGuidanceMcpTool[];
}

export interface AgentGuidanceRuntimeStatusResponse {
  ok: boolean;
  enabled: boolean;
  source: 'defaults' | 'file' | 'invalid_file_with_defaults';
  guidance_hash: string;
  config_path: string;
  expected_tool_count: number;
  warnings: string[];
}

export interface AgentGuidanceIntegrationStatusResponse {
  ok: boolean;
  agent?: 'claude' | 'codex';
  configured?: boolean;
  up_to_date?: boolean;
  guidance?: {
    config_valid: boolean;
    enabled: boolean;
    source: string;
    guidance_hash: string;
    config_path: string;
    warnings: string[];
  };
  mcp?: { expected_tool_count: number; configured: boolean; up_to_date: boolean; status: string };
  restart_required?: boolean;
  warnings: string[];
  error?: { code: string; message: string; details?: string[] };
}

export interface AgentGuidanceIntegrationApplyResponse {
  ok: boolean;
  agent?: 'claude' | 'codex';
  dry_run?: boolean;
  guidance_hash?: string;
  planned_action?: string;
  restart_required?: boolean;
  warnings: string[];
  error?: { code: string; message: string; details?: string[] };
}

export interface AgentGuidanceConfigApi {
  getAgentGuidanceConfig(): Promise<AgentGuidanceReadResponse>;
  setAgentGuidanceConfig(config: AgentGuidanceConfigView): Promise<AgentGuidanceWriteResponse>;
  resetAgentGuidanceConfig(): Promise<AgentGuidanceWriteResponse>;
  getAgentGuidanceDefaults(): Promise<AgentGuidanceDefaultsResponse>;
  getAgentGuidanceConfigPath(): Promise<AgentGuidanceConfigPathResponse>;
  getAgentGuidanceMcpTools(): Promise<AgentGuidanceMcpToolsResponse>;
  getAgentGuidanceRuntimeStatus(): Promise<AgentGuidanceRuntimeStatusResponse>;
  getAgentGuidanceIntegrationStatus(agent: 'claude' | 'codex'): Promise<AgentGuidanceIntegrationStatusResponse>;
  getAgentGuidanceTerminalPreflightConfig(): Promise<{
    ok: boolean;
    terminal_preflight?: TerminalPreflightConfigView;
    configPath?: string;
    guidance_hash?: string;
    last_result?: TerminalPreflightLastResultView;
    warnings?: string[];
    error?: { code: string; message: string; details?: string[] };
  }>;
  setAgentGuidanceTerminalPreflightConfig(config: TerminalPreflightConfigView): Promise<{
    ok: boolean;
    terminal_preflight?: TerminalPreflightConfigView;
    configPath?: string;
    guidance_hash?: string;
    warnings?: string[];
    error?: { code: string; message: string; details?: string[] };
  }>;
  dryRunAgentGuidanceIntegration(agent: 'claude' | 'codex'): Promise<AgentGuidanceIntegrationApplyResponse>;
  applyAgentGuidanceIntegration(agent: 'claude' | 'codex', confirmed: boolean): Promise<AgentGuidanceIntegrationApplyResponse>;
}

export interface AgentGuidancePreview {
  enabled: boolean;
  text: string;
}

export interface AgentGuidanceStatus {
  kind: 'info' | 'ok' | 'error';
  text: string;
}

export interface AgentGuidanceSettingsView {
  setConfig(config: AgentGuidanceConfigView): void;
  setPath(info: AgentGuidanceConfigPathResponse): void;
  setStatus(status: AgentGuidanceStatus): void;
  setMcpTools(tools: AgentGuidanceMcpTool[]): void;
  setEffectiveGuidance(preview: AgentGuidancePreview): void;
  setTerminalPreflight?(view: TerminalPreflightViewModel): void;
  setIntegrationStatus?(agent: 'claude' | 'codex', status: AgentGuidanceStatus & { hash?: string; expectedToolCount?: number }): void;
  setIntegrationPlan?(agent: 'claude' | 'codex', status: AgentGuidanceStatus & { hash?: string }): void;
}

export interface AgentGuidanceSettingsController {
  refresh(): Promise<void>;
  save(config: AgentGuidanceConfigView): Promise<void>;
  reset(): Promise<void>;
  dryRunApply(agent: 'claude' | 'codex'): Promise<void>;
  apply(agent: 'claude' | 'codex', confirmed: boolean): Promise<void>;
}

export interface AgentGuidanceSettingsModule {
  TERMINAL_PREFLIGHT_COPY: string;
  buildEffectivePreviewText(opts: { config: AgentGuidanceConfigView; mcpTools: AgentGuidanceMcpTool[] }): string;
  buildTerminalPreflightView(opts: {
    terminal_preflight?: TerminalPreflightConfigView;
    last_result?: TerminalPreflightLastResultView;
  }): TerminalPreflightViewModel;
  buildStatusMessage(opts: {
    ok?: boolean;
    source?: 'default' | 'file';
    exists?: boolean;
    configPath?: string;
    error?: { code: string; message: string };
  }): AgentGuidanceStatus;
  createController(opts: {
    api: AgentGuidanceConfigApi;
    view: AgentGuidanceSettingsView;
  }): AgentGuidanceSettingsController;
}

declare const AgentGuidanceSettings: AgentGuidanceSettingsModule;
export default AgentGuidanceSettings;
