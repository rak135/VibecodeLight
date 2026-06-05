import { Command } from 'commander';

import {
  parseCodeGraphTransport,
  type CodeGraphTransport,
} from '../../../adapters/codegraph/codegraph_transport.js';
import {
  applyCodexMcpInstall,
  buildCodexMcpConfig,
  parseMcpScope,
  runCodexMcpDoctor,
  type McpConfigScope,
} from '../../../core/mcp/codex_config.js';
import {
  applyClaudeMcpInstall,
  buildClaudeMcpConfig,
  buildClaudeMcpInstallCommand,
  parseClaudeMcpScope,
  runClaudeMcpDoctor,
  type ClaudeMcpScope,
} from '../../../core/mcp/claude_config.js';
import { resolveRepoRoot } from '../../../core/workspace/repo_root.js';
import {
  createVibecodeMcpServer,
  VIBECODE_MCP_TOOL_NAMES,
  type McpLogLevel,
} from '../../mcp/index.js';

/**
 * CLI surface for the VibecodeMCP stdio server:
 *
 *   vibecode mcp serve --repo <path> [--codegraph-transport cli|mcp|auto]
 *                                    [--codegraph-bin <path>]
 *                                    [--log-level info|warn|silent]
 *
 *   vibecode mcp tools
 *       — print the canonical Phase MCP-1 tool name list (no server is started).
 *
 * stdout is reserved for the MCP JSON-RPC stream. Diagnostic logs go to stderr
 * (controlled by --log-level) and per-call usage rows go to
 * `<repo>/.vibecode/logs/mcp_tool_usage.jsonl`.
 */

interface CliStructuredError {
  code: string;
  message: string;
  path: string;
  details: string[];
}

export interface McpCommandDependencies {
  makeCliStructuredError: (code: string, message: string, pathValue?: string, details?: string[]) => CliStructuredError;
  emitCliStructuredError: (error: CliStructuredError, options: { json?: boolean; prefix: string }) => void;
}

function parseLogLevel(value: string | undefined): McpLogLevel | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'info' || normalized === 'warn' || normalized === 'silent') return normalized;
  return undefined;
}

function parseAgentAndScope(options: { agent?: string; scope?: string }):
  | { ok: true; agent: 'codex'; scope: McpConfigScope }
  | { ok: true; agent: 'claude'; scope: ClaudeMcpScope }
  | { ok: false; error: CliStructuredError } {
  const agent = options.agent?.trim().toLowerCase();
  if (agent !== 'codex' && agent !== 'claude') {
    return {
      ok: false,
      error: {
        code: 'INVALID_AGENT',
        message: `invalid --agent: ${options.agent ?? ''}`,
        path: '',
        details: ['Expected one of: codex, claude.'],
      },
    };
  }

  const scope = agent === 'claude' ? parseClaudeMcpScope(options.scope) : parseMcpScope(options.scope);
  if (!scope) {
    const expected = agent === 'claude' ? 'local, user, project' : 'user, project';
    return {
      ok: false,
      error: {
        code: 'INVALID_SCOPE',
        message: `invalid --scope: ${options.scope ?? ''}`,
        path: '',
        details: [`Expected one of: ${expected}.`],
      },
    };
  }

  if (agent === 'claude') return { ok: true, agent, scope: scope as ClaudeMcpScope };
  return { ok: true, agent, scope: scope as McpConfigScope };
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

export function registerMcpCommands(
  program: Command,
  dependencies: McpCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const mcp = program.command('mcp').description('VibecodeMCP server commands');

  mcp
    .command('config')
    .description('Generate agent MCP config for VibecodeMCP')
    .requiredOption('--agent <agent>', 'Agent to configure: codex | claude')
    .requiredOption('--repo <path>', 'Repository path to bind VibecodeMCP to')
    .option('--scope <scope>', 'Agent config scope. Codex: user | project. Claude: local | user | project')
    .option('--print', 'Print the TOML snippet')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { agent: string; repo: string; scope?: string; print?: boolean; json?: boolean }) => {
      const parsed = parseAgentAndScope(options);
      if (!parsed.ok) {
        emitCliStructuredError(parsed.error, { json: options.json, prefix: 'mcp config failed' });
        return;
      }
      const resolved = resolveRepoRoot({ repoArg: options.repo });
      if (!resolved.ok) {
        emitCliStructuredError(
          makeCliStructuredError(resolved.error.code, resolved.error.message, resolved.error.resolvedPath, resolved.error.details),
          { json: options.json, prefix: 'mcp config failed' },
        );
        return;
      }

      if (parsed.agent === 'claude') {
        const result = buildClaudeMcpConfig({ repoRoot: resolved.repoRoot, scope: parsed.scope });
        if (options.json) {
          printJson(result);
          return;
        }
        const command = buildClaudeMcpInstallCommand({ repoRoot: resolved.repoRoot, scope: parsed.scope });
        console.log(JSON.stringify(result.data.server_config, null, 2));
        console.log('');
        console.log(`Equivalent command: ${command.display_command}`);
        return;
      }

      const result = buildCodexMcpConfig({ repoRoot: resolved.repoRoot, scope: parsed.scope });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(result.toml_snippet.trimEnd());
    });

  mcp
    .command('install')
    .description('Install or update VibecodeMCP in an agent config')
    .requiredOption('--agent <agent>', 'Agent to configure: codex | claude')
    .requiredOption('--repo <path>', 'Repository path to bind VibecodeMCP to')
    .option('--scope <scope>', 'Agent config scope. Codex: user | project. Claude: local | user | project')
    .option('--dry-run', 'Preview the planned config change without writing')
    .option('--yes', 'Write the config change')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { agent: string; repo: string; scope?: string; dryRun?: boolean; yes?: boolean; json?: boolean }) => {
      const parsed = parseAgentAndScope(options);
      if (!parsed.ok) {
        emitCliStructuredError(parsed.error, { json: options.json, prefix: 'mcp install failed' });
        return;
      }
      const resolved = resolveRepoRoot({ repoArg: options.repo });
      if (!resolved.ok) {
        emitCliStructuredError(
          makeCliStructuredError(resolved.error.code, resolved.error.message, resolved.error.resolvedPath, resolved.error.details),
          { json: options.json, prefix: 'mcp install failed' },
        );
        return;
      }

      if (parsed.agent === 'claude') {
        const result = applyClaudeMcpInstall({
          repoRoot: resolved.repoRoot,
          scope: parsed.scope,
          dryRun: options.dryRun === true,
          yes: options.yes === true,
        });
        if (!result.ok) {
          if (options.json) printJson(result);
          else {
            console.error(`mcp install failed: ${result.error.message}`);
            if (result.error.path) console.error(`path: ${result.error.path}`);
            for (const detail of result.error.details ?? []) console.error(`detail: ${detail}`);
          }
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          printJson(result);
          return;
        }
        console.log(`Claude MCP server: ${result.server_name}`);
        console.log(`Scope: ${result.scope}`);
        console.log(`Command: ${result.planned_command}`);
        if (result.dry_run) console.log('Dry run: no Claude config was modified.');
        if (result.stdout.trim()) console.log(`Claude stdout: ${result.stdout.trimEnd()}`);
        if (result.stderr.trim()) console.log(`Claude stderr: ${result.stderr.trimEnd()}`);
        console.log('Restart Claude Code or run /mcp to inspect connected servers.');
        for (const warning of result.warnings) console.log(`Warning: ${warning}`);
        return;
      }

      const result = applyCodexMcpInstall({
        repoRoot: resolved.repoRoot,
        scope: parsed.scope,
        dryRun: options.dryRun === true,
        yes: options.yes === true,
      });
      if (!result.ok) {
        if (options.json) printJson(result);
        else {
          console.error(`mcp install failed: ${result.error.message}`);
          if (result.error.path) console.error(`path: ${result.error.path}`);
          for (const detail of result.error.details ?? []) console.error(`detail: ${detail}`);
        }
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(`Codex MCP config: ${result.config_path}`);
      console.log(`Action: ${result.action} [mcp_servers.vibecode]`);
      console.log(`Existing server: ${result.existing_server ? 'yes' : 'no'}`);
      if (result.dry_run) console.log('Dry run: no files were written.');
      if (result.backup_path) console.log(`Backup: ${result.backup_path}`);
      console.log('Restart or reload Codex before using VibecodeMCP.');
    });

  mcp
    .command('doctor')
    .description('Check VibecodeMCP Codex config and tool availability')
    .requiredOption('--agent <agent>', 'Agent to inspect: codex | claude')
    .requiredOption('--repo <path>', 'Repository path bound to VibecodeMCP')
    .option('--scope <scope>', 'Agent config scope. Codex: user | project. Claude: local | user | project')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { agent: string; repo: string; scope?: string; json?: boolean }) => {
      const parsed = parseAgentAndScope(options);
      if (!parsed.ok) {
        emitCliStructuredError(parsed.error, { json: options.json, prefix: 'mcp doctor failed' });
        return;
      }
      const resolved = resolveRepoRoot({ repoArg: options.repo });
      if (!resolved.ok) {
        emitCliStructuredError(
          makeCliStructuredError(resolved.error.code, resolved.error.message, resolved.error.resolvedPath, resolved.error.details),
          { json: options.json, prefix: 'mcp doctor failed' },
        );
        return;
      }

      if (parsed.agent === 'claude') {
        const result = runClaudeMcpDoctor({ repoRoot: resolved.repoRoot, scope: parsed.scope });
        if (options.json) {
          printJson(result);
        } else {
          console.log(`Claude MCP doctor: ${result.ok ? 'OK' : 'FAILED'}`);
          console.log(`Server: ${result.server_name}`);
          console.log(`Scope: ${result.scope}`);
          for (const [name, check] of Object.entries(result.checks)) {
            console.log(`${check.ok ? 'OK' : 'WARN'} ${name}: ${check.message}`);
          }
          if (result.warnings.length > 0) {
            console.log('Warnings:');
            for (const warning of result.warnings) console.log(`  - ${warning}`);
          }
          if (result.suggestions.length > 0) {
            console.log('Suggestions:');
            for (const suggestion of result.suggestions) console.log(`  - ${suggestion}`);
          }
        }
        if (!result.ok) process.exitCode = 1;
        return;
      }

      const result = runCodexMcpDoctor({ repoRoot: resolved.repoRoot, scope: parsed.scope });
      if (options.json) {
        printJson(result);
      } else {
        console.log(`Codex MCP doctor: ${result.ok ? 'OK' : 'FAILED'}`);
        console.log(`Config: ${result.config_path}`);
        for (const [name, check] of Object.entries(result.checks)) {
          console.log(`${check.ok ? 'OK' : 'WARN'} ${name}: ${check.message}`);
        }
        if (result.warnings.length > 0) {
          console.log('Warnings:');
          for (const warning of result.warnings) console.log(`  - ${warning}`);
        }
        if (result.suggestions.length > 0) {
          console.log('Suggestions:');
          for (const suggestion of result.suggestions) console.log(`  - ${suggestion}`);
        }
      }
      if (!result.ok) process.exitCode = 1;
    });

  mcp
    .command('serve')
    .description('Start the repo-bound stdio MCP server (read-only CodeGraph tools)')
    .requiredOption('--repo <path>', 'Repository path (required; server is bound to this repo for its lifetime)')
    .option('--codegraph-transport <transport>', 'Override the persisted CodeGraph transport for this server: cli | mcp | auto')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path used by the bound tools')
    .option('--log-level <level>', 'stderr verbosity for the server: info | warn | silent', 'info')
    .action(async (options: { repo: string; codegraphTransport?: string; codegraphBin?: string; logLevel?: string }) => {
      const resolved = resolveRepoRoot({ repoArg: options.repo });
      if (!resolved.ok) {
        emitCliStructuredError(
          makeCliStructuredError(resolved.error.code, resolved.error.message, resolved.error.resolvedPath, resolved.error.details),
          { json: false, prefix: 'mcp serve failed' },
        );
        return;
      }

      let codegraphTransport: CodeGraphTransport | undefined;
      if (options.codegraphTransport !== undefined) {
        const parsed = parseCodeGraphTransport(options.codegraphTransport);
        if (!parsed) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_CODEGRAPH_TRANSPORT',
              `invalid --codegraph-transport: ${options.codegraphTransport}`,
              '',
              ['Expected one of: cli, mcp, auto.'],
            ),
            { json: false, prefix: 'mcp serve failed' },
          );
          return;
        }
        codegraphTransport = parsed;
      }

      const logLevel = parseLogLevel(options.logLevel) ?? 'info';

      const handle = createVibecodeMcpServer({
        context: {
          repoRoot: resolved.repoRoot,
          ...(options.codegraphBin ? { codegraphBinary: options.codegraphBin } : {}),
          ...(codegraphTransport ? { codegraphTransport } : {}),
        },
        logLevel,
      });

      const shutdown = async (signal: string): Promise<void> => {
        try {
          await handle.close();
        } catch (err) {
          process.stderr.write(`[vibecode-mcp] shutdown error after ${signal}: ${err instanceof Error ? err.message : String(err)}\n`);
        } finally {
          process.exit(0);
        }
      };

      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

      try {
        await handle.connect();
      } catch (err) {
        process.stderr.write(`[vibecode-mcp] failed to start stdio server: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });

  mcp
    .command('tools')
    .description('Print the canonical VibecodeMCP tool names exposed by this server (no server is started)')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { json?: boolean }) => {
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: { tools: [...VIBECODE_MCP_TOOL_NAMES] },
          artifacts: [],
          warnings: [],
        }));
        return;
      }
      console.log('VibecodeMCP tools:');
      for (const name of VIBECODE_MCP_TOOL_NAMES) console.log(`  - ${name}`);
    });
}
