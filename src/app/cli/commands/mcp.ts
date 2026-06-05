import { Command } from 'commander';

import {
  parseCodeGraphTransport,
  type CodeGraphTransport,
} from '../../../adapters/codegraph/codegraph_transport.js';
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

export function registerMcpCommands(
  program: Command,
  dependencies: McpCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const mcp = program.command('mcp').description('VibecodeMCP server commands');

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
