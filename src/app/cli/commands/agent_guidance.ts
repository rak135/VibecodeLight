import { Command } from 'commander';

import {
  applyAgentGuidanceIntegration,
  getAgentGuidanceIntegrationStatus,
  type AgentGuidanceIntegrationAgent,
} from '../../../core/agent_guidance/agent_guidance_apply.js';
import {
  runTerminalAgentPreflight,
} from '../../../core/agent_guidance/terminal_agent_preflight.js';
import type { AgentGuidanceTerminalPreflightMode } from '../../../core/config/agent_guidance_config.js';
import { resolveRepoRoot } from '../../../core/workspace/repo_root.js';

interface CliStructuredError {
  code: string;
  message: string;
  path: string;
  details: string[];
}

export interface AgentGuidanceCommandDependencies {
  makeCliStructuredError: (code: string, message: string, pathValue?: string, details?: string[]) => CliStructuredError;
  emitCliStructuredError: (error: CliStructuredError, options: { json?: boolean; prefix: string }) => void;
}

function parseAgent(value: string | undefined): AgentGuidanceIntegrationAgent | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'claude' || normalized === 'codex' ? normalized : null;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

function parseTerminalPreflightMode(value: string | undefined): AgentGuidanceTerminalPreflightMode | null | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim();
  if (normalized === 'check_only' || normalized === 'auto_repair') return normalized;
  return null;
}

export function registerAgentGuidanceCommands(
  program: Command,
  dependencies: AgentGuidanceCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;
  const cmd = program.command('agent-guidance').description('Agent Guidance status and safe MCP integration commands');

  cmd
    .command('status')
    .description('Inspect Agent Guidance config and whether an agent can receive it through VibecodeMCP')
    .requiredOption('--agent <agent>', 'Agent to inspect: claude | codex')
    .requiredOption('--repo <path>', 'Repository path bound to VibecodeMCP')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { agent: string; repo: string; json?: boolean }) => {
      const agent = parseAgent(options.agent);
      if (!agent) {
        emitCliStructuredError(
          makeCliStructuredError('INVALID_AGENT', `invalid --agent: ${options.agent}`, '', ['Expected one of: claude, codex.']),
          { json: options.json, prefix: 'agent-guidance status failed' },
        );
        return;
      }
      const resolved = resolveRepoRoot({ repoArg: options.repo });
      if (!resolved.ok) {
        emitCliStructuredError(
          makeCliStructuredError(resolved.error.code, resolved.error.message, resolved.error.resolvedPath, resolved.error.details),
          { json: options.json, prefix: 'agent-guidance status failed' },
        );
        return;
      }
      const result = getAgentGuidanceIntegrationStatus({ agent, repoRoot: resolved.repoRoot, env: process.env });
      if (options.json) {
        printJson(result);
        return;
      }
      if (!result.ok) {
        console.error(`agent-guidance status failed: ${result.error?.message ?? 'unknown error'}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Agent Guidance ${agent}: ${result.configured ? 'configured' : 'not configured'}`);
      console.log(`Guidance hash: ${result.guidance?.guidance_hash}`);
      console.log(`Config: ${result.guidance?.config_path}`);
      console.log(`MCP tools expected: ${result.mcp?.expected_tool_count}`);
      console.log('Guidance is exposed through VibecodeMCP; no terminal text is injected.');
      console.log('Restart/reconnect the agent if an MCP session is already running.');
    });

  cmd
    .command('apply')
    .description('Ensure an agent is configured to use VibecodeMCP so Agent Guidance is available to new MCP sessions')
    .requiredOption('--agent <agent>', 'Agent to configure: claude | codex')
    .requiredOption('--repo <path>', 'Repository path bound to VibecodeMCP')
    .option('--dry-run', 'Preview the planned config change without writing')
    .option('--yes', 'Write/update the MCP config')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { agent: string; repo: string; dryRun?: boolean; yes?: boolean; json?: boolean }) => {
      const agent = parseAgent(options.agent);
      if (!agent) {
        emitCliStructuredError(
          makeCliStructuredError('INVALID_AGENT', `invalid --agent: ${options.agent}`, '', ['Expected one of: claude, codex.']),
          { json: options.json, prefix: 'agent-guidance apply failed' },
        );
        return;
      }
      const resolved = resolveRepoRoot({ repoArg: options.repo });
      if (!resolved.ok) {
        emitCliStructuredError(
          makeCliStructuredError(resolved.error.code, resolved.error.message, resolved.error.resolvedPath, resolved.error.details),
          { json: options.json, prefix: 'agent-guidance apply failed' },
        );
        return;
      }
      const result = applyAgentGuidanceIntegration({
        agent,
        repoRoot: resolved.repoRoot,
        env: process.env,
        dryRun: options.dryRun === true,
        yes: options.yes === true,
      });
      if (options.json) {
        printJson(result);
      } else if (result.ok) {
        console.log(`Agent Guidance ${agent}: ${result.dry_run ? 'dry-run' : 'applied'}`);
        console.log(`Guidance hash: ${result.guidance_hash}`);
        console.log(result.planned_action ?? '');
        console.log('Changes apply to new agent/MCP sessions. Restart/reconnect the agent if already running.');
        console.log('No terminal text, final_prompt.md mutation, or approval/permission mutation is performed.');
      } else {
        console.error(`agent-guidance apply failed: ${result.error?.message ?? 'unknown error'}`);
      }
      if (!result.ok) process.exitCode = 1;
    });

  cmd
    .command('preflight')
    .description('Run Terminal Agent Preflight without opening a terminal')
    .requiredOption('--repo <path>', 'Repository path bound to VibecodeMCP')
    .option('--terminal', 'Select terminal preflight behavior')
    .option('--mode <mode>', 'Terminal preflight mode: check_only | auto_repair')
    .option('--json', 'Output canonical JSON envelope')
    .action(async (options: { repo: string; terminal?: boolean; mode?: string; json?: boolean }) => {
      if (options.terminal !== true) {
        emitCliStructuredError(
          makeCliStructuredError('TERMINAL_PREFLIGHT_REQUIRED', 'agent-guidance preflight currently supports --terminal only.', '', ['Add --terminal.']),
          { json: options.json, prefix: 'agent-guidance preflight failed' },
        );
        return;
      }
      const mode = parseTerminalPreflightMode(options.mode);
      if (mode === null) {
        emitCliStructuredError(
          makeCliStructuredError(
            'INVALID_TERMINAL_PREFLIGHT_MODE',
            `invalid --mode: ${options.mode}`,
            '',
            ['Expected one of: check_only, auto_repair.'],
          ),
          { json: options.json, prefix: 'agent-guidance preflight failed' },
        );
        return;
      }
      const resolved = resolveRepoRoot({ repoArg: options.repo });
      if (!resolved.ok) {
        emitCliStructuredError(
          makeCliStructuredError(resolved.error.code, resolved.error.message, resolved.error.resolvedPath, resolved.error.details),
          { json: options.json, prefix: 'agent-guidance preflight failed' },
        );
        return;
      }
      const result = await runTerminalAgentPreflight({
        repoRoot: resolved.repoRoot,
        env: process.env,
        modeOverride: mode,
      });
      if (options.json) {
        printJson(result);
      } else {
        console.log(`Terminal Agent Preflight: ${result.ok ? 'ok' : 'warning'}`);
        console.log(`Mode: ${result.mode}`);
        console.log(`Guidance hash: ${result.guidance_hash}`);
        for (const agent of result.agents) {
          console.log(`${agent.agent}: ${agent.status}${agent.repaired ? ' repaired' : ''}`);
        }
        if (result.warnings.length > 0) {
          console.log('warnings:');
          for (const warning of result.warnings) console.log(`  ${warning}`);
        }
        if (result.errors.length > 0) {
          console.log('errors:');
          for (const error of result.errors) console.log(`  ${error}`);
        }
        console.log('No terminal text is injected; users start agents manually.');
      }
      process.exitCode = result.ok ? 0 : 1;
    });
}
