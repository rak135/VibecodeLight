import fs from 'fs';

import {
  applyCodexMcpInstall,
  buildCodexMcpConfig,
  extractTomlTableBlock,
  type CodexInstallOptions,
} from '../mcp/codex_config.js';
import {
  applyClaudeMcpInstall,
  buildClaudeMcpInstallCommand,
  type ClaudeMcpInstallOptions,
} from '../mcp/claude_config.js';
import {
  detectClaudeMcpConfig,
  type ClaudeMcpDetectedScope,
  type ClaudeMcpDetectedSource,
} from '../mcp/claude_mcp_detect.js';
import { buildAgentGuidanceMcpTools } from '../config/agent_guidance_mcp_tools.js';
import { buildAgentGuidanceRuntime } from './agent_guidance_runtime.js';

export type AgentGuidanceIntegrationAgent = 'claude' | 'codex';

export interface AgentGuidanceIntegrationError {
  code: 'INVALID_AGENT' | 'AGENT_GUIDANCE_APPLY_FAILED' | 'CONFIRMATION_REQUIRED';
  message: string;
  path?: string;
  details?: string[];
}

export interface AgentGuidanceIntegrationStatus {
  ok: boolean;
  agent?: AgentGuidanceIntegrationAgent;
  repo_root?: string;
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
  mcp?: {
    expected_tool_count: number;
    configured: boolean;
    up_to_date: boolean;
    status: 'up_to_date' | 'stale' | 'not_configured' | 'unknown';
    command?: string;
    args?: string[];
    /** Claude only: the effective config scope that provides the server, when detected. */
    source?: ClaudeMcpDetectedScope;
    /** Claude only: the config file path of the effective source, when detected. */
    source_path?: string;
    /** Claude only: the repo path the detected server is bound to, when detectable. */
    repo_binding?: string;
    /** Claude only: every recognized config source (local/project/user) found. */
    sources?: ClaudeMcpDetectedSource[];
  };
  approval_boundary?: string;
  restart_required?: boolean;
  warnings: string[];
  error?: AgentGuidanceIntegrationError;
}

export interface AgentGuidanceApplyResult {
  ok: boolean;
  agent?: AgentGuidanceIntegrationAgent;
  repo_root?: string;
  dry_run?: boolean;
  guidance_hash?: string;
  guidance_config_path?: string;
  planned_action?: string;
  installer_result?: unknown;
  restart_required?: boolean;
  warnings: string[];
  error?: AgentGuidanceIntegrationError;
}

interface BaseOptions {
  agent: AgentGuidanceIntegrationAgent;
  repoRoot: string;
  env?: Record<string, string | undefined>;
  codexHome?: string;
  vibecodeBinPath?: string;
  claudeCommand?: string;
  /** Directory holding Claude's `.claude.json`; defaults to CLAUDE_CONFIG_DIR or the user home. */
  claudeConfigDir?: string;
}

export interface AgentGuidanceIntegrationStatusOptions extends BaseOptions {}

export interface AgentGuidanceIntegrationApplyOptions extends BaseOptions {
  dryRun?: boolean;
  yes?: boolean;
  claudeRunner?: ClaudeMcpInstallOptions['runner'];
}

const APPROVAL_BOUNDARY =
  'Vibecode does not manage Claude/Codex approvals or permission settings; the agent client owns those decisions.';
const EXPECTED_TOOL_COUNT = buildAgentGuidanceMcpTools().length;

function invalidAgent(agent: unknown): AgentGuidanceIntegrationStatus {
  return {
    ok: false,
    warnings: [],
    error: {
      code: 'INVALID_AGENT',
      message: `invalid --agent: ${String(agent)}`,
      details: ['Expected one of: claude, codex.'],
    },
  };
}

function isAgent(value: unknown): value is AgentGuidanceIntegrationAgent {
  return value === 'claude' || value === 'codex';
}

function guidanceSummary(opts: { env?: Record<string, string | undefined> }) {
  const runtime = buildAgentGuidanceRuntime({ env: opts.env });
  return {
    runtime,
    guidance: {
      config_valid: runtime.config_valid,
      enabled: runtime.enabled,
      source: runtime.source,
      guidance_hash: runtime.guidance_hash,
      config_path: runtime.config_path,
      warnings: runtime.warnings,
    },
  };
}

export function getAgentGuidanceIntegrationStatus(
  options: AgentGuidanceIntegrationStatusOptions,
): AgentGuidanceIntegrationStatus {
  if (!isAgent(options.agent)) return invalidAgent(options.agent);
  const { runtime, guidance } = guidanceSummary({ env: options.env });
  const warnings = [...runtime.warnings];

  if (options.agent === 'codex') {
    const config = buildCodexMcpConfig({
      repoRoot: options.repoRoot,
      codexHome: options.codexHome ?? options.env?.CODEX_HOME,
      vibecodeBinPath: options.vibecodeBinPath,
    });
    let configured = false;
    let upToDate = false;
    try {
      if (fs.existsSync(config.config_path)) {
        const block = extractTomlTableBlock(fs.readFileSync(config.config_path, 'utf8'), 'mcp_servers.vibecode');
        configured = Boolean(block);
        upToDate = Boolean(block && config.args.every((arg) => block.includes(arg.replace(/\\/g, '/'))));
      }
    } catch (err) {
      warnings.push(`CODEX_CONFIG_STATUS_WARNING: ${err instanceof Error ? err.message : String(err)}`);
    }
    const status = configured ? (upToDate ? 'up_to_date' : 'stale') : 'not_configured';
    return {
      ok: true,
      agent: 'codex',
      repo_root: options.repoRoot,
      configured,
      up_to_date: upToDate,
      guidance,
      mcp: {
        expected_tool_count: EXPECTED_TOOL_COUNT,
        configured,
        up_to_date: upToDate,
        status,
        command: config.command,
        args: config.args,
      },
      approval_boundary: APPROVAL_BOUNDARY,
      restart_required: true,
      warnings,
    };
  }

  const command = buildClaudeMcpInstallCommand({
    repoRoot: options.repoRoot,
    vibecodeBinPath: options.vibecodeBinPath,
    claudeCommand: options.claudeCommand,
  });
  const detection = detectClaudeMcpConfig({
    repoRoot: options.repoRoot,
    vibecodeBinPath: options.vibecodeBinPath,
    env: options.env,
    claudeConfigDir: options.claudeConfigDir,
  });
  warnings.push(...detection.warnings);
  const effective = detection.effective;
  const upToDate = detection.status === 'up_to_date';
  return {
    ok: true,
    agent: 'claude',
    repo_root: options.repoRoot,
    configured: detection.configured,
    up_to_date: upToDate,
    guidance,
    mcp: {
      expected_tool_count: EXPECTED_TOOL_COUNT,
      configured: detection.configured,
      up_to_date: upToDate,
      status: detection.status,
      command: effective?.command ?? command.command,
      args: effective?.args ?? command.args,
      ...(effective ? { source: effective.scope, source_path: effective.config_path } : {}),
      ...(effective?.repo_binding ? { repo_binding: effective.repo_binding } : {}),
      sources: detection.sources,
    },
    approval_boundary: APPROVAL_BOUNDARY,
    restart_required: true,
    warnings,
  };
}

export function applyAgentGuidanceIntegration(
  options: AgentGuidanceIntegrationApplyOptions,
): AgentGuidanceApplyResult {
  if (!isAgent(options.agent)) {
    return { ...invalidAgent(options.agent), warnings: [] };
  }
  const { runtime } = guidanceSummary({ env: options.env });
  const base = {
    agent: options.agent,
    repo_root: options.repoRoot,
    dry_run: options.dryRun === true,
    guidance_hash: runtime.guidance_hash,
    guidance_config_path: runtime.config_path,
    restart_required: true,
    warnings: [...runtime.warnings, APPROVAL_BOUNDARY],
  };

  if (!options.dryRun && !options.yes) {
    return {
      ok: false,
      ...base,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: 'Refusing to apply Agent Guidance integration without --yes. Use --dry-run to preview or --yes to update MCP config.',
        details: ['No terminal text, repo instruction file, approval setting, or permission setting was written.'],
      },
    };
  }

  if (options.agent === 'codex') {
    const installOptions: CodexInstallOptions = {
      repoRoot: options.repoRoot,
      codexHome: options.codexHome ?? options.env?.CODEX_HOME,
      vibecodeBinPath: options.vibecodeBinPath,
      dryRun: options.dryRun,
      yes: options.yes,
    };
    const result = applyCodexMcpInstall(installOptions);
    if (!result.ok) {
      return {
        ok: false,
        ...base,
        warnings: [...base.warnings, ...result.warnings],
        error: {
          code: 'AGENT_GUIDANCE_APPLY_FAILED',
          message: result.error.message,
          path: result.error.path,
          details: result.error.details,
        },
      };
    }
    return {
      ok: true,
      ...base,
      planned_action: `${result.dry_run ? 'Dry-run update' : 'Update'} Codex VibecodeMCP server config so new MCP sessions expose guidance through vibecode_mcp_guidance.`,
      installer_result: result,
      warnings: [...base.warnings, ...result.warnings],
    };
  }

  const result = applyClaudeMcpInstall({
    repoRoot: options.repoRoot,
    vibecodeBinPath: options.vibecodeBinPath,
    claudeCommand: options.claudeCommand,
    dryRun: options.dryRun,
    yes: options.yes,
    runner: options.claudeRunner,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...base,
      warnings: [...base.warnings, ...result.warnings],
      error: {
        code: 'AGENT_GUIDANCE_APPLY_FAILED',
        message: result.error.message,
        path: result.error.path,
        details: result.error.details,
      },
    };
  }
  return {
    ok: true,
    ...base,
    planned_action: `${result.dry_run ? 'Dry-run' : 'Run'} ${result.planned_command}. New MCP sessions expose guidance through vibecode_mcp_guidance.`,
    installer_result: result,
    warnings: [...base.warnings, ...result.warnings],
  };
}
