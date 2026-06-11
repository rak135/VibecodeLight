import {
  getMcpDashboardOverview,
  type McpDashboardOptions,
} from '../../core/mcp/mcp_dashboard.js';
import {
  getMcpToolCatalog,
  getMcpToolDetail,
} from '../mcp/tool_catalog.js';
import {
  applyAgentGuidanceIntegration,
  getAgentGuidanceIntegrationStatus,
  type AgentGuidanceIntegrationAgent,
} from '../../core/agent_guidance/agent_guidance_apply.js';
import { buildAgentGuidanceMcpTools } from '../../core/config/agent_guidance_mcp_tools.js';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface McpBridgeOptions {
  getRepoPath: () => string;
}

function parseAgent(raw: unknown): AgentGuidanceIntegrationAgent | null {
  return raw === 'claude' || raw === 'codex' || raw === 'opencode' ? raw : null;
}

function invalidAgentPayload(raw: unknown) {
  return {
    ok: false,
    warnings: [],
    error: {
      code: 'INVALID_AGENT',
      message: `Invalid agent: ${String(raw)}`,
      details: ['Expected one of: claude, codex, opencode.'],
    },
  };
}

function buildMcpOptions(options: McpBridgeOptions): McpDashboardOptions {
  return {
    repoRoot: options.getRepoPath(),
    env: process.env,
  };
}

/**
 * Register desktop MCP IPC handlers. This bridge is read-only on overview/doctor
 * and requires explicit confirmation for install/write actions.
 */
export function registerDesktopMcpIpcHandlers(ipcMain: IpcMainLike, options: McpBridgeOptions): void {
  ipcMain.handle('mcp:getOverview', () => {
    return getMcpDashboardOverview(buildMcpOptions(options));
  });

  ipcMain.handle('mcp:doctor', (_event, agentRaw: unknown) => {
    const agent = parseAgent(agentRaw);
    if (!agent) return invalidAgentPayload(agentRaw);
    return getAgentGuidanceIntegrationStatus({
      agent,
      repoRoot: options.getRepoPath(),
      env: process.env,
    });
  });

  ipcMain.handle('mcp:installDryRun', (_event, agentRaw: unknown) => {
    const agent = parseAgent(agentRaw);
    if (!agent) return invalidAgentPayload(agentRaw);
    return applyAgentGuidanceIntegration({
      agent,
      repoRoot: options.getRepoPath(),
      env: process.env,
      dryRun: true,
    });
  });

  ipcMain.handle('mcp:install', (_event, agentRaw: unknown, confirmed: unknown) => {
    const agent = parseAgent(agentRaw);
    if (!agent) return invalidAgentPayload(agentRaw);
    if (confirmed !== true) {
      return {
        ok: false,
        warnings: [],
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'MCP install requires explicit confirmation. Run dry-run first.',
          details: ['No agent config was modified.'],
        },
      };
    }
    return applyAgentGuidanceIntegration({
      agent,
      repoRoot: options.getRepoPath(),
      env: process.env,
      yes: true,
    });
  });

  ipcMain.handle('mcp:getTools', () => {
    return {
      ok: true,
      tools: buildAgentGuidanceMcpTools(),
    };
  });

  ipcMain.handle('mcp:getToolCatalog', () => {
    return getMcpToolCatalog();
  });

  ipcMain.handle('mcp:getToolDetail', (_event, nameRaw: unknown) => {
    if (typeof nameRaw !== 'string') return null;
    return getMcpToolDetail(nameRaw);
  });
}
