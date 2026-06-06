import { Command } from 'commander';

import {
  applyAgentGuidanceIntegration,
  getAgentGuidanceIntegrationStatus,
  type AgentGuidanceIntegrationAgent,
} from '../../../core/agent_guidance/agent_guidance_apply.js';
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
}
