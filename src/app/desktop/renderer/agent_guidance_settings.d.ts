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

export interface AgentGuidanceConfigApi {
  getAgentGuidanceConfig(): Promise<AgentGuidanceReadResponse>;
  setAgentGuidanceConfig(config: AgentGuidanceConfigView): Promise<AgentGuidanceWriteResponse>;
  resetAgentGuidanceConfig(): Promise<AgentGuidanceWriteResponse>;
  getAgentGuidanceDefaults(): Promise<AgentGuidanceDefaultsResponse>;
  getAgentGuidanceConfigPath(): Promise<AgentGuidanceConfigPathResponse>;
  getAgentGuidanceMcpTools(): Promise<AgentGuidanceMcpToolsResponse>;
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
}

export interface AgentGuidanceSettingsController {
  refresh(): Promise<void>;
  save(config: AgentGuidanceConfigView): Promise<void>;
  reset(): Promise<void>;
}

export interface AgentGuidanceSettingsModule {
  buildEffectivePreviewText(opts: { config: AgentGuidanceConfigView; mcpTools: AgentGuidanceMcpTool[] }): string;
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
