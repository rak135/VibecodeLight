import { buildAgentGuidanceMcpTools } from '../config/agent_guidance_mcp_tools.js';
import {
  getAgentGuidanceIntegrationStatus,
  type AgentGuidanceIntegrationAgent,
  type AgentGuidanceIntegrationStatus,
} from '../agent_guidance/agent_guidance_apply.js';

export interface McpDashboardAgent {
  agent: 'claude' | 'codex' | 'opencode';
  status: 'up_to_date' | 'stale' | 'not_configured' | 'unknown' | 'error';
  scope?: string;
  config_path?: string;
  checks?: Record<string, { ok: boolean; message: string }>;
  warnings: string[];
  suggestions: string[];
  can_install: boolean;
  can_update: boolean;
  mcp?: {
    expected_tool_count: number;
    configured: boolean;
    up_to_date: boolean;
    status: string;
  };
  guidance?: {
    config_valid: boolean;
    enabled: boolean;
    source: string;
    guidance_hash: string;
    config_path: string;
    warnings: string[];
  };
}

export interface McpDashboardOverview {
  ok: boolean;
  repo_root: string;
  server_name: string;
  tools_count: number;
  tools: string[];
  agents: McpDashboardAgent[];
  warnings: string[];
}

export interface McpDashboardOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  codexHome?: string;
  vibecodeBinPath?: string;
  claudeConfigDir?: string;
  opencodeConfigDir?: string;
}

const ALL_AGENTS: AgentGuidanceIntegrationAgent[] = ['claude', 'codex', 'opencode'];

function mapAgentStatus(integration: AgentGuidanceIntegrationStatus): McpDashboardAgent['status'] {
  if (!integration.ok) return 'error';
  if (integration.up_to_date) return 'up_to_date';
  if (integration.configured) return 'stale';
  return 'not_configured';
}

export function getMcpDashboardOverview(options: McpDashboardOptions): McpDashboardOverview {
  const warnings: string[] = [];
  const agents: McpDashboardAgent[] = [];

  for (const agent of ALL_AGENTS) {
    try {
      const status = getAgentGuidanceIntegrationStatus({
        agent,
        repoRoot: options.repoRoot,
        env: options.env,
        codexHome: options.codexHome,
        vibecodeBinPath: options.vibecodeBinPath,
        claudeConfigDir: options.claudeConfigDir,
        opencodeConfigDir: options.opencodeConfigDir,
      });

      warnings.push(...status.warnings);

      const mappedStatus = mapAgentStatus(status);
      const mappedAgent: McpDashboardAgent = {
        agent,
        status: mappedStatus,
        scope: status.mcp?.source ?? (status.agent === 'codex' ? 'user' : status.agent === 'opencode' ? 'project' : 'local'),
        config_path: status.mcp?.source_path ?? status.guidance?.config_path,
        checks: 'checks' in status ? (status as Record<string, unknown>).checks as Record<string, { ok: boolean; message: string }> : undefined,
        warnings: status.warnings,
        suggestions: 'suggestions' in status ? (status as Record<string, unknown>).suggestions as string[] : [],
        can_install: mappedStatus !== 'up_to_date',
        can_update: mappedStatus === 'stale',
        mcp: status.mcp,
        guidance: status.guidance,
      };

      agents.push(mappedAgent);
    } catch (error) {
      warnings.push(`DASHBOARD_AGENT_ERROR: ${agent}: ${error instanceof Error ? error.message : String(error)}`);
      agents.push({
        agent,
        status: 'error',
        warnings: [error instanceof Error ? error.message : String(error)],
        suggestions: [],
        can_install: true,
        can_update: false,
      });
    }
  }

  const tools = buildAgentGuidanceMcpTools();

  return {
    ok: true,
    repo_root: options.repoRoot,
    server_name: 'vibecode',
    tools_count: tools.length,
    tools: tools.map((t) => t.name),
    agents,
    warnings: [...new Set(warnings)],
  };
}
