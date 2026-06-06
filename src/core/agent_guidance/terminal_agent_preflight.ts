import fs from 'fs';
import path from 'path';

import {
  applyAgentGuidanceIntegration,
  getAgentGuidanceIntegrationStatus,
  type AgentGuidanceApplyResult,
  type AgentGuidanceIntegrationAgent,
  type AgentGuidanceIntegrationApplyOptions,
  type AgentGuidanceIntegrationStatus,
  type AgentGuidanceIntegrationStatusOptions,
} from './agent_guidance_apply.js';
import { buildAgentGuidanceRuntime } from './agent_guidance_runtime.js';
import {
  getAgentGuidanceConfigPath,
  readAgentGuidanceConfig,
  type AgentGuidanceTerminalPreflightMode,
} from '../config/agent_guidance_config.js';
import { resolveUserProfileDir } from '../config/user_profile.js';

export type TerminalAgentPreflightAgent = AgentGuidanceIntegrationAgent;

export interface TerminalAgentPreflightAgentResult {
  agent: TerminalAgentPreflightAgent;
  configured: boolean;
  stale: boolean;
  repaired: boolean;
  status?: 'up_to_date' | 'stale' | 'not_configured' | 'unknown' | 'error';
  warning?: string;
  error?: string;
  warnings: string[];
  errors: string[];
}

export interface TerminalAgentPreflightResult {
  ok: boolean;
  skipped?: boolean;
  mode: AgentGuidanceTerminalPreflightMode;
  repo_root: string;
  config_path: string;
  guidance_hash: string;
  checked_at?: string;
  agents: TerminalAgentPreflightAgentResult[];
  warnings: string[];
  errors: string[];
  no_pty_injection: true;
}

export type TerminalAgentPreflightStatusProvider = (
  options: AgentGuidanceIntegrationStatusOptions,
) => AgentGuidanceIntegrationStatus;

export type TerminalAgentPreflightApplyProvider = (
  options: AgentGuidanceIntegrationApplyOptions,
) => AgentGuidanceApplyResult;

export interface RunTerminalAgentPreflightOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  modeOverride?: AgentGuidanceTerminalPreflightMode;
  statusProvider?: TerminalAgentPreflightStatusProvider;
  applyProvider?: TerminalAgentPreflightApplyProvider;
  now?: () => Date;
  log?: boolean;
}

const SUPPORTED_AGENTS: TerminalAgentPreflightAgent[] = ['codex', 'claude'];

function statusToAgentResult(status: AgentGuidanceIntegrationStatus): TerminalAgentPreflightAgentResult {
  const configured = status.configured === true;
  const upToDate = status.up_to_date === true;
  const statusValue = status.mcp?.status ?? (configured ? (upToDate ? 'up_to_date' : 'stale') : 'not_configured');
  return {
    agent: status.agent ?? 'codex',
    configured,
    stale: configured && !upToDate,
    repaired: false,
    status: statusValue,
    warning: status.warnings[0],
    error: status.error?.message,
    warnings: status.warnings,
    errors: status.error ? [status.error.message] : [],
  };
}

function applyErrorToAgentResult(
  base: TerminalAgentPreflightAgentResult,
  apply: AgentGuidanceApplyResult,
): TerminalAgentPreflightAgentResult {
  return {
    ...base,
    repaired: false,
    status: 'error',
    error: apply.error?.message ?? 'Agent Guidance preflight repair failed.',
    warnings: [...base.warnings, ...apply.warnings],
    errors: [...base.errors, apply.error?.message ?? 'Agent Guidance preflight repair failed.'],
  };
}

function shouldRepair(agent: TerminalAgentPreflightAgentResult): boolean {
  return agent.configured === false || agent.stale === true || agent.status === 'not_configured';
}

function getLogPath(env: Record<string, string | undefined>): string {
  return path.join(resolveUserProfileDir(env), 'terminal-agent-preflight.log');
}

function writeLog(
  env: Record<string, string | undefined>,
  result: TerminalAgentPreflightResult,
): void {
  const record = {
    checked_at: result.checked_at,
    repo_root: result.repo_root,
    mode: result.mode,
    guidance_hash: result.guidance_hash,
    ok: result.ok,
    agents: result.agents.map((agent) => ({
      agent: agent.agent,
      configured: agent.configured,
      stale: agent.stale,
      repaired: agent.repaired,
      status: agent.status,
      warnings: agent.warnings,
      errors: agent.errors,
    })),
    warnings: result.warnings,
    errors: result.errors,
  };
  const logPath = getLogPath(env);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function maybeLog(env: Record<string, string | undefined>, result: TerminalAgentPreflightResult, enabled: boolean): void {
  if (!enabled) return;
  try {
    writeLog(env, result);
  } catch {
    // Diagnostics are best-effort. A log failure must never block a terminal.
  }
}

export async function runTerminalAgentPreflight(
  options: RunTerminalAgentPreflightOptions,
): Promise<TerminalAgentPreflightResult> {
  const env = options.env ?? process.env;
  const repoRoot = path.resolve(options.repoRoot);
  const runtime = buildAgentGuidanceRuntime({ env });
  const read = readAgentGuidanceConfig({ env });
  const preflightConfig = read.config.terminal_preflight;
  const mode = options.modeOverride ?? preflightConfig.mode;
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const base = {
    mode,
    repo_root: repoRoot,
    config_path: runtime.config_path || getAgentGuidanceConfigPath(env),
    guidance_hash: runtime.guidance_hash,
    checked_at: checkedAt,
    no_pty_injection: true as const,
  };
  const warnings = [...runtime.warnings, ...read.warnings];

  if (!preflightConfig.enabled) {
    const result: TerminalAgentPreflightResult = {
      ok: true,
      skipped: true,
      ...base,
      agents: [],
      warnings,
      errors: [],
    };
    maybeLog(env, result, options.log !== false);
    return result;
  }

  if (mode === 'auto_repair' && preflightConfig.repair.require_valid_guidance_config && !runtime.config_valid) {
    const result: TerminalAgentPreflightResult = {
      ok: false,
      ...base,
      agents: [],
      warnings,
      errors: ['Agent Guidance config is invalid; terminal preflight auto repair was skipped.'],
    };
    maybeLog(env, result, options.log !== false);
    return result;
  }

  const statusProvider = options.statusProvider ?? getAgentGuidanceIntegrationStatus;
  const applyProvider = options.applyProvider ?? applyAgentGuidanceIntegration;
  const agents: TerminalAgentPreflightAgentResult[] = [];
  const errors: string[] = [];

  for (const agent of SUPPORTED_AGENTS) {
    if (!preflightConfig.supported_agents[agent]) continue;
    let agentResult: TerminalAgentPreflightAgentResult;
    try {
      const status = statusProvider({ agent, repoRoot, env });
      if (!status.ok) {
        agentResult = {
          agent,
          configured: false,
          stale: false,
          repaired: false,
          status: 'error',
          error: status.error?.message ?? 'Agent Guidance status failed.',
          warnings: status.warnings,
          errors: [status.error?.message ?? 'Agent Guidance status failed.'],
        };
      } else {
        agentResult = statusToAgentResult(status);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentResult = {
        agent,
        configured: false,
        stale: false,
        repaired: false,
        status: 'error',
        error: message,
        warnings: [],
        errors: [message],
      };
    }

    if (mode === 'auto_repair' && shouldRepair(agentResult)) {
      try {
        const applied = applyProvider({ agent, repoRoot, env, yes: true, dryRun: false });
        if (applied.ok) {
          agentResult = {
            ...agentResult,
            repaired: true,
            configured: true,
            stale: false,
            status: 'up_to_date',
            warnings: [...agentResult.warnings, ...applied.warnings],
          };
        } else {
          agentResult = applyErrorToAgentResult(agentResult, applied);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        agentResult = {
          ...agentResult,
          status: 'error',
          error: message,
          errors: [...agentResult.errors, message],
        };
      }
    }

    if (agentResult.error) errors.push(`${agent}: ${agentResult.error}`);
    agents.push(agentResult);
  }

  const result: TerminalAgentPreflightResult = {
    ok: errors.length === 0,
    ...base,
    agents,
    warnings,
    errors,
  };
  maybeLog(env, result, options.log !== false);
  return result;
}
