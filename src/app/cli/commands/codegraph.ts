import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import {
  getCodeGraphStatus,
  initializeCodeGraphRepo,
  reindexCodeGraphRepo,
  syncCodeGraphRepo,
} from '../../../adapters/codegraph/codegraph_actions.js';
import {
  buildCodeGraphMcpAgentConfig,
  runCodeGraphMcpSelfTest,
} from '../../../adapters/codegraph/codegraph_mcp.js';
import {
  runCodeGraphCallees,
  runCodeGraphCallers,
  runCodeGraphContextQuery,
  runCodeGraphFiles,
  runCodeGraphImpact,
  runCodeGraphSearch,
  type CodeGraphQueryResult,
} from '../../../adapters/codegraph/codegraph_query_commands.js';
import {
  codeGraphBinaryDiagnostics,
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import {
  buildCodeGraphQueryEvent,
  logCodeGraphQuery,
  resolveRunIdForLogging,
  type CodeGraphQueryLogError,
  type CodeGraphQueryLogInput,
  type CodeGraphQuerySubcommand,
  type CodeGraphQueryLogWriteResult,
} from '../../../adapters/codegraph/codegraph_query_log.js';
import {
  CODEGRAPH_TRANSPORT_VALUES,
  parseCodeGraphTransport,
  type CodeGraphTransport,
} from '../../../adapters/codegraph/codegraph_transport.js';
import {
  InvalidCodeGraphBinaryError,
  readCodeGraphBinarySetting,
  readCodeGraphTransportSetting,
  resetCodeGraphBinarySetting,
  resetCodeGraphTransportSetting,
  writeCodeGraphBinarySetting,
  writeCodeGraphTransportSetting,
} from '../../../core/config/index.js';

interface CliStructuredError {
  code: string;
  message: string;
  path: string;
  details: string[];
}

export interface CodeGraphCommandDependencies {
  makeCliStructuredError: (code: string, message: string, pathValue?: string, details?: string[]) => CliStructuredError;
  emitCliStructuredError: (error: CliStructuredError, options: { json?: boolean; prefix: string }) => void;
}

function formatCodeGraphStatusLine(status: { available: boolean; initialized: boolean; version?: string }): string {
  if (!status.available) return 'codegraph status: not available';
  const parts = ['codegraph status: available', status.initialized ? 'initialized' : 'not initialized'];
  if (status.version) parts.push(status.version);
  return parts.join(' · ');
}

function codeGraphTransportSettingData(setting: {
  transport: CodeGraphTransport;
  default: CodeGraphTransport;
  source: 'global' | 'default';
  globalConfigPath: string;
  globalConfigExists: boolean;
}): Record<string, unknown> {
  return {
    transport: setting.transport,
    default: setting.default,
    source: setting.source,
    global_config_path: setting.globalConfigPath,
    global_config_exists: setting.globalConfigExists,
  };
}

function printCodeGraphTransportSetting(setting: ReturnType<typeof readCodeGraphTransportSetting>, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      data: codeGraphTransportSettingData(setting),
      artifacts: [],
      warnings: setting.warnings,
    }));
    return;
  }
  console.log(`codegraph.transport: ${setting.transport}`);
  console.log(`source: ${setting.source}`);
  console.log(`default: ${setting.default}`);
  console.log(`global_config: ${setting.globalConfigPath} (${setting.globalConfigExists ? 'exists' : 'absent'})`);
  for (const warning of setting.warnings) console.log(`warning: ${warning}`);
}

function codeGraphBinarySettingData(resolution: CodeGraphBinaryResolution, globalConfigPath: string, globalConfigExists: boolean): Record<string, unknown> {
  return {
    configured: resolution.configured,
    source: resolution.source,
    command: resolution.command,
    global_config_path: globalConfigPath,
    global_config_exists: globalConfigExists,
  };
}

function buildCodeGraphActionFailure(
  makeCliStructuredError: CodeGraphCommandDependencies['makeCliStructuredError'],
  action: 'status' | 'init' | 'sync' | 'reindex',
  repoRoot: string,
  message: string,
  details: string[] = [],
): CliStructuredError {
  return makeCliStructuredError(
    `CODEGRAPH_${action.toUpperCase()}_FAILED`,
    message,
    repoRoot,
    details,
  );
}


interface CodeGraphQueryCliEnvelope {
  label: string;
  inputKey: 'query' | 'symbol' | 'input';
  inputValue?: string;
}

function exitCodeFromError(error: CodeGraphQueryLogError | undefined | null, ok: boolean): number | null {
  if (ok) return 0;
  if (!error) return null;
  if (error.code === 'CODEGRAPH_QUERY_FAILED') return 1;
  if (error.code === 'INVALID_ARGUMENT' || error.code === 'INVALID_REPO_PATH') return null;
  return null;
}

function relPathUnder(repoRoot: string, full: string): string {
  const rel = path.relative(repoRoot, full).split(path.sep).join('/');
  return rel.startsWith('..') ? full : rel;
}

interface LogRunInvocationOptions {
  subcommand: CodeGraphQuerySubcommand;
  repoRoot: string;
  runIdOption: string | undefined;
  input: CodeGraphQueryLogInput;
  invoke: () => CodeGraphQueryResult;
}

interface LogRunInvocationOutput {
  result: CodeGraphQueryResult;
  logResult: CodeGraphQueryLogWriteResult;
  runId: string | null;
}

function runAndLogCodeGraphQuery(opts: LogRunInvocationOptions): LogRunInvocationOutput {
  const runId = resolveRunIdForLogging(opts.runIdOption);
  const started = Date.now();
  const result = opts.invoke();
  const durationMs = Date.now() - started;

  const stdoutText = result.stdoutText ?? '';
  const stdoutBytes = Buffer.byteLength(stdoutText, 'utf8');
  // stderr is not surfaced through the adapter result; only warnings reflect it
  const stderrBytes = 0;
  const parsedJson = result.parsedJson !== undefined;
  const items = Array.isArray(result.parsedJson) ? result.parsedJson.length : null;
  const truncated = result.warnings.some((w) => w.startsWith('CODEGRAPH_FILES_TRUNCATED'));
  const error: CodeGraphQueryLogError | null = result.error
    ? {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.attempted_binary ? { attempted_binary: result.error.attempted_binary } : {}),
        ...(result.error.binary_source ? { binary_source: result.error.binary_source } : {}),
      }
    : null;
  const exitCode = exitCodeFromError(error, result.ok);

  const event = buildCodeGraphQueryEvent({
    subcommand: opts.subcommand,
    repoRoot: opts.repoRoot,
    runId,
    command: result.command,
    input: opts.input,
    ok: result.ok,
    exitCode,
    durationMs,
    warnings: result.warnings,
    error,
    stdoutBytes,
    stderrBytes,
    parsedJson,
    items,
    truncated,
  });

  const logResult = logCodeGraphQuery({ repoRoot: opts.repoRoot, runId, event });
  return { result, logResult, runId };
}

function emitCodeGraphQueryResult(
  result: CodeGraphQueryResult,
  envelope: CodeGraphQueryCliEnvelope,
  options: { json?: boolean; logResult?: CodeGraphQueryLogWriteResult; repoRoot?: string },
): void {
  const logBlock = options.logResult
    ? {
        workspace_log: options.repoRoot
          ? relPathUnder(options.repoRoot, options.logResult.workspaceLogPath)
          : options.logResult.workspaceLogPath,
        run_log:
          options.logResult.runLogPath !== null
            ? options.repoRoot
              ? relPathUnder(options.repoRoot, options.logResult.runLogPath)
              : options.logResult.runLogPath
            : null,
        warnings: options.logResult.warnings,
      }
    : undefined;

  if (options.json) {
    const payload: Record<string, unknown> = {
      ok: result.ok,
      command: result.command,
      repoRoot: result.repoRoot,
      warnings: result.warnings,
    };
    if (envelope.inputValue !== undefined) payload[envelope.inputKey] = envelope.inputValue;
    if (result.stdoutText !== undefined) payload.stdoutText = result.stdoutText;
    if (result.parsedJson !== undefined) payload.parsedJson = result.parsedJson;
    if (result.scoreMeta) payload.score_meta = result.scoreMeta;
    if (result.error) payload.error = result.error;
    if (logBlock) payload.log = logBlock;
    console.log(JSON.stringify(payload));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    console.error(`${envelope.label} failed: ${result.error?.message ?? 'unknown error'}`);
    if (result.error?.code) console.error(`code: ${result.error.code}`);
    if (result.stdoutText) console.error(result.stdoutText);
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    process.exitCode = 1;
    return;
  }

  console.log(`# ${envelope.label}`);
  console.log('');
  if (envelope.inputValue !== undefined) {
    const inputTitle = envelope.inputKey === 'query' ? 'Query' : envelope.inputKey === 'symbol' ? 'Symbol' : 'Input';
    console.log(`${inputTitle}: ${envelope.inputValue}`);
  }
  console.log(`Repo: ${result.repoRoot}`);
  console.log('');
  if (result.stdoutText && result.stdoutText.trim()) {
    console.log(result.stdoutText.trimEnd());
    console.log('');
  } else {
    console.log('(no results)');
    console.log('');
  }
  console.log(`Command: ${result.command.join(' ')}`);
  console.log('');
  if (result.warnings.length === 0) {
    console.log('Warnings: none');
  } else {
    console.log('Warnings:');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
}

function parsePositiveIntegerOption(value: string | undefined, label: string): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: `invalid ${label}: ${value}` };
  }
  return { ok: true, value: parsed };
}

function registerCodeGraphQueryCommands(codegraph: Command, dependencies: CodeGraphCommandDependencies): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;
  codegraph
    .command('search <query>')
    .description('Search for symbols in the indexed codebase (read-only)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--max-results <n>', 'Maximum number of results to return')
    .option('--timeout <ms>', 'Timeout for the underlying codegraph command in milliseconds')
    .option('--run-id <id>', 'Run id for run-scoped logging (no fake run dirs)')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action((query: string, options: { repo: string; json?: boolean; maxResults?: string; timeout?: string; runId?: string; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const maxResults = parsePositiveIntegerOption(options.maxResults, '--max-results');
      if (!maxResults.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', maxResults.message), { json: options.json, prefix: 'codegraph search failed' });
        return;
      }
      const timeout = parsePositiveIntegerOption(options.timeout, '--timeout');
      if (!timeout.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', timeout.message), { json: options.json, prefix: 'codegraph search failed' });
        return;
      }
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      const { result, logResult } = runAndLogCodeGraphQuery({
        subcommand: 'search',
        repoRoot,
        runIdOption: options.runId,
        input: {
          query,
          ...(maxResults.value !== undefined ? { max_results: maxResults.value } : {}),
        },
        invoke: () =>
          runCodeGraphSearch({
            repoRoot,
            query,
            command: binary.command,
            binarySource: binary.source,
            ...(maxResults.value !== undefined ? { maxResults: maxResults.value } : {}),
            ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
            ...(options.json ? { json: true } : {}),
          }),
      });
      emitCodeGraphQueryResult(
        result,
        { label: 'CodeGraph Search', inputKey: 'query', inputValue: query },
        { json: options.json, logResult, repoRoot },
      );
    });

  codegraph
    .command('context <query>')
    .description('Build bounded markdown context for a task (read-only)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--max-nodes <n>', 'Maximum nodes to include')
    .option('--max-code <n>', 'Maximum code blocks to include')
    .option('--timeout <ms>', 'Timeout for the underlying codegraph command in milliseconds')
    .option('--run-id <id>', 'Run id for run-scoped logging (no fake run dirs)')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action((query: string, options: { repo: string; json?: boolean; maxNodes?: string; maxCode?: string; timeout?: string; runId?: string; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const maxNodes = parsePositiveIntegerOption(options.maxNodes, '--max-nodes');
      if (!maxNodes.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', maxNodes.message), { json: options.json, prefix: 'codegraph context failed' });
        return;
      }
      const maxCode = parsePositiveIntegerOption(options.maxCode, '--max-code');
      if (!maxCode.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', maxCode.message), { json: options.json, prefix: 'codegraph context failed' });
        return;
      }
      const timeout = parsePositiveIntegerOption(options.timeout, '--timeout');
      if (!timeout.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', timeout.message), { json: options.json, prefix: 'codegraph context failed' });
        return;
      }
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      const { result, logResult } = runAndLogCodeGraphQuery({
        subcommand: 'context',
        repoRoot,
        runIdOption: options.runId,
        input: {
          query,
          ...(maxNodes.value !== undefined ? { max_nodes: maxNodes.value } : {}),
          ...(maxCode.value !== undefined ? { max_code: maxCode.value } : {}),
        },
        invoke: () =>
          runCodeGraphContextQuery({
            repoRoot,
            query,
            command: binary.command,
            binarySource: binary.source,
            ...(maxNodes.value !== undefined ? { maxNodes: maxNodes.value } : {}),
            ...(maxCode.value !== undefined ? { maxCode: maxCode.value } : {}),
            ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
            ...(options.json ? { json: true } : {}),
          }),
      });
      emitCodeGraphQueryResult(
        result,
        { label: 'CodeGraph Context', inputKey: 'query', inputValue: query },
        { json: options.json, logResult, repoRoot },
      );
    });

  codegraph
    .command('files')
    .description('Show indexed project file structure (read-only)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--limit <n>', 'Maximum number of file entries returned in --json output')
    .option('--timeout <ms>', 'Timeout for the underlying codegraph command in milliseconds')
    .option('--run-id <id>', 'Run id for run-scoped logging (no fake run dirs)')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action((options: { repo: string; json?: boolean; limit?: string; timeout?: string; runId?: string; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const limit = parsePositiveIntegerOption(options.limit, '--limit');
      if (!limit.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', limit.message), { json: options.json, prefix: 'codegraph files failed' });
        return;
      }
      const timeout = parsePositiveIntegerOption(options.timeout, '--timeout');
      if (!timeout.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', timeout.message), { json: options.json, prefix: 'codegraph files failed' });
        return;
      }
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      const { result, logResult } = runAndLogCodeGraphQuery({
        subcommand: 'files',
        repoRoot,
        runIdOption: options.runId,
        input: {
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
        },
        invoke: () =>
          runCodeGraphFiles({
            repoRoot,
            command: binary.command,
            binarySource: binary.source,
            ...(limit.value !== undefined ? { limit: limit.value } : {}),
            ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
            ...(options.json ? { json: true } : {}),
          }),
      });
      emitCodeGraphQueryResult(
        result,
        { label: 'CodeGraph Files', inputKey: 'input' },
        { json: options.json, logResult, repoRoot },
      );
    });

  const registerSymbolCommand = (
    name: 'callers' | 'callees',
    label: string,
    runner: typeof runCodeGraphCallers,
  ): void => {
    codegraph
      .command(`${name} <symbol>`)
      .description(`Find ${name} for a symbol in the indexed codebase (read-only)`)
      .option('--repo <path>', 'Repository path', process.cwd())
      .option('--json', 'Output canonical JSON envelope')
      .option('--limit <n>', 'Maximum number of results to return')
      .option('--timeout <ms>', 'Timeout for the underlying codegraph command in milliseconds')
      .option('--run-id <id>', 'Run id for run-scoped logging (no fake run dirs)')
      .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
      .action((symbol: string, options: { repo: string; json?: boolean; limit?: string; timeout?: string; runId?: string; codegraphBin?: string }) => {
        const repoRoot = path.resolve(options.repo);
        const limit = parsePositiveIntegerOption(options.limit, '--limit');
        if (!limit.ok) {
          emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', limit.message), { json: options.json, prefix: `codegraph ${name} failed` });
          return;
        }
        const timeout = parsePositiveIntegerOption(options.timeout, '--timeout');
        if (!timeout.ok) {
          emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', timeout.message), { json: options.json, prefix: `codegraph ${name} failed` });
          return;
        }
        const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
        const { result, logResult } = runAndLogCodeGraphQuery({
          subcommand: name,
          repoRoot,
          runIdOption: options.runId,
          input: {
            symbol,
            ...(limit.value !== undefined ? { limit: limit.value } : {}),
          },
          invoke: () =>
            runner({
              repoRoot,
              symbol,
              command: binary.command,
              binarySource: binary.source,
              ...(limit.value !== undefined ? { limit: limit.value } : {}),
              ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
              ...(options.json ? { json: true } : {}),
            }),
        });
        emitCodeGraphQueryResult(
          result,
          { label, inputKey: 'symbol', inputValue: symbol },
          { json: options.json, logResult, repoRoot },
        );
      });
  };

  registerSymbolCommand('callers', 'CodeGraph Callers', runCodeGraphCallers);
  registerSymbolCommand('callees', 'CodeGraph Callees', runCodeGraphCallees);

  codegraph
    .command('impact <input>')
    .description('Analyze the impact of changing a symbol or file (read-only)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--limit <n>', 'Traversal depth (maps to codegraph impact --depth)')
    .option('--timeout <ms>', 'Timeout for the underlying codegraph command in milliseconds')
    .option('--run-id <id>', 'Run id for run-scoped logging (no fake run dirs)')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action((input: string, options: { repo: string; json?: boolean; limit?: string; timeout?: string; runId?: string; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const limit = parsePositiveIntegerOption(options.limit, '--limit');
      if (!limit.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', limit.message), { json: options.json, prefix: 'codegraph impact failed' });
        return;
      }
      const timeout = parsePositiveIntegerOption(options.timeout, '--timeout');
      if (!timeout.ok) {
        emitCliStructuredError(makeCliStructuredError('INVALID_ARGUMENT', timeout.message), { json: options.json, prefix: 'codegraph impact failed' });
        return;
      }
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      const { result, logResult } = runAndLogCodeGraphQuery({
        subcommand: 'impact',
        repoRoot,
        runIdOption: options.runId,
        input: {
          path_or_symbol: input,
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
        },
        invoke: () =>
          runCodeGraphImpact({
            repoRoot,
            symbol: input,
            command: binary.command,
            binarySource: binary.source,
            ...(limit.value !== undefined ? { limit: limit.value } : {}),
            ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
            ...(options.json ? { json: true } : {}),
          }),
      });
      emitCodeGraphQueryResult(
        result,
        { label: 'CodeGraph Impact', inputKey: 'input', inputValue: input },
        { json: options.json, logResult, repoRoot },
      );
    });
}

export function registerCodeGraphCommands(program: Command, dependencies: CodeGraphCommandDependencies): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const codegraph = program.command('codegraph').description('CodeGraph repository operations');

  codegraph
    .command('status')
    .description('Show CodeGraph availability and initialization status for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action(async (options: { repo: string; json?: boolean; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      const result = await getCodeGraphStatus(repoRoot, { command: binary.command, binary });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            available: result.available,
            initialized: result.initialized,
            version: result.version,
            binary: codeGraphBinaryDiagnostics(binary),
          },
          artifacts: [],
          warnings: result.warnings,
        }));
        return;
      }
      console.log(formatCodeGraphStatusLine(result));
      console.log(`binary: ${binary.command} (source: ${binary.source})`);
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
      if (!result.available) {
        console.log('hint: Set VIBECODE_CODEGRAPH_BIN or run `vibecode codegraph binary set <path>`.');
      }
    });

  const codegraphTransport = codegraph
    .command('transport')
    .description('Inspect and set the persisted CodeGraph context transport (cli | mcp | auto)');

  codegraphTransport
    .command('get')
    .description('Show the persisted CodeGraph transport setting (defaults to cli)')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { json?: boolean }) => {
      printCodeGraphTransportSetting(readCodeGraphTransportSetting({ env: process.env }), options.json);
    });

  codegraphTransport
    .command('set <transport>')
    .description('Persist the CodeGraph transport setting in the global user config')
    .option('--json', 'Output canonical JSON envelope')
    .action((transportValue: string, options: { json?: boolean }) => {
      const transport = parseCodeGraphTransport(transportValue);
      if (!transport) {
        emitCliStructuredError(
          makeCliStructuredError(
            'INVALID_CODEGRAPH_TRANSPORT',
            `invalid CodeGraph transport: ${transportValue}`,
            '',
            [`Expected one of: ${CODEGRAPH_TRANSPORT_VALUES.join(', ')}.`],
          ),
          { json: options.json, prefix: 'codegraph transport set failed' },
        );
        return;
      }
      const result = writeCodeGraphTransportSetting({ transport, env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: codeGraphTransportSettingData(result),
          artifacts: [result.artifactPath],
          warnings: result.warnings,
        }));
        return;
      }
      console.log(`codegraph.transport: ${result.transport}`);
      console.log(`global_config: ${result.globalConfigPath}`);
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
    });

  codegraphTransport
    .command('reset')
    .description('Reset CodeGraph transport to the default (cli)')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { json?: boolean }) => {
      const result = resetCodeGraphTransportSetting({ env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: codeGraphTransportSettingData(result),
          artifacts: result.globalConfigExists ? [result.artifactPath] : [],
          warnings: result.warnings,
        }));
        return;
      }
      console.log(`codegraph.transport: ${result.transport}`);
      console.log(`source: ${result.source}`);
      console.log(`global_config: ${result.globalConfigPath} (${result.globalConfigExists ? 'exists' : 'absent'})`);
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
    });

  const runCodeGraphAction = async (
    action: 'init' | 'sync' | 'reindex',
    repoRoot: string,
    runner: () => Promise<Awaited<ReturnType<typeof initializeCodeGraphRepo>>>,
    json?: boolean,
  ): Promise<void> => {
    const result = await runner();
    if (!result.ok) {
      emitCliStructuredError(
        buildCodeGraphActionFailure(
          makeCliStructuredError,
          action,
          repoRoot,
          result.error?.message ?? `codegraph ${action} failed`,
          [
            ...(result.stderrSummary ? [result.stderrSummary] : []),
            ...(result.stdoutSummary ? [result.stdoutSummary] : []),
            ...(result.error?.details ? [result.error.details] : []),
          ],
        ),
        { json, prefix: `codegraph ${action} failed` },
      );
      return;
    }

    if (json) {
      console.log(JSON.stringify({
        ok: true,
        data: {
          stdout: result.stdoutSummary ?? '',
          stderr: result.stderrSummary ?? '',
        },
        artifacts: [],
        warnings: [],
      }));
      return;
    }

    const summary = result.stdoutSummary?.trim() || result.stderrSummary?.trim();
    console.log(summary ? `codegraph ${action}: ok · ${summary}` : `codegraph ${action}: ok`);
  };

  codegraph
    .command('init')
    .description('Initialize CodeGraph for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action(async (options: { repo: string; json?: boolean; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      await runCodeGraphAction(
        'init',
        repoRoot,
        () => initializeCodeGraphRepo(repoRoot, { command: binary.command, binary }),
        options.json,
      );
    });

  codegraph
    .command('sync')
    .description('Sync an existing CodeGraph index for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action(async (options: { repo: string; json?: boolean; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      await runCodeGraphAction(
        'sync',
        repoRoot,
        () => syncCodeGraphRepo(repoRoot, { command: binary.command, binary }),
        options.json,
      );
    });

  codegraph
    .command('reindex')
    .description('Force a full CodeGraph reindex for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--codegraph-bin <path>', 'Override the upstream codegraph binary path for this invocation')
    .action(async (options: { repo: string; json?: boolean; codegraphBin?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const binary = resolveCodeGraphBinary({ cliOption: options.codegraphBin, env: process.env });
      await runCodeGraphAction(
        'reindex',
        repoRoot,
        () => reindexCodeGraphRepo(repoRoot, { command: binary.command, binary }),
        options.json,
      );
    });

  const codegraphBinary = codegraph
    .command('binary')
    .description('Inspect and set the persisted upstream CodeGraph binary path');

  codegraphBinary
    .command('get')
    .description('Show the configured CodeGraph binary path and effective resolver result')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { json?: boolean }) => {
      const setting = readCodeGraphBinarySetting({ env: process.env });
      const resolution = resolveCodeGraphBinary({ env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: codeGraphBinarySettingData(resolution, setting.globalConfigPath, setting.globalConfigExists),
          artifacts: [],
          warnings: setting.warnings,
        }));
        return;
      }
      console.log(`codegraph.binary configured: ${resolution.configured ?? '(none)'}`);
      console.log(`source: ${resolution.source}`);
      console.log(`effective command: ${resolution.command}`);
      console.log(`global_config: ${setting.globalConfigPath} (${setting.globalConfigExists ? 'exists' : 'absent'})`);
      for (const warning of setting.warnings) console.log(`warning: ${warning}`);
    });

  codegraphBinary
    .command('set <path>')
    .description('Persist the CodeGraph binary path in the global user config')
    .option('--json', 'Output canonical JSON envelope')
    .action((binaryPath: string, options: { json?: boolean }) => {
      try {
        const written = writeCodeGraphBinarySetting({ binary: binaryPath, env: process.env });
        const warnings = [...written.warnings];
        const trimmed = binaryPath.trim();
        if (trimmed && !fs.existsSync(trimmed)) {
          warnings.push(`CODEGRAPH_BINARY_PATH_MISSING: ${trimmed} does not exist on disk`);
        }
        const resolution: CodeGraphBinaryResolution = {
          command: written.binary ?? trimmed,
          source: 'GLOBAL_CONFIG',
          configured: written.binary,
        };
        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            data: codeGraphBinarySettingData(resolution, written.globalConfigPath, written.globalConfigExists),
            artifacts: [written.artifactPath],
            warnings,
          }));
          return;
        }
        console.log(`codegraph.binary: ${written.binary}`);
        console.log(`global_config: ${written.globalConfigPath}`);
        for (const warning of warnings) console.log(`warning: ${warning}`);
      } catch (err) {
        if (err instanceof InvalidCodeGraphBinaryError) {
          emitCliStructuredError(
            makeCliStructuredError(
              'INVALID_CODEGRAPH_BINARY',
              err.message,
              '',
              ['CodeGraph binary path must be a non-empty string.'],
            ),
            { json: options.json, prefix: 'codegraph binary set failed' },
          );
          return;
        }
        throw err;
      }
    });

  codegraphBinary
    .command('reset')
    .description('Remove the persisted CodeGraph binary path from the global user config')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { json?: boolean }) => {
      const result = resetCodeGraphBinarySetting({ env: process.env });
      const resolution = resolveCodeGraphBinary({ env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: codeGraphBinarySettingData(resolution, result.globalConfigPath, result.globalConfigExists),
          artifacts: result.globalConfigExists ? [result.artifactPath] : [],
          warnings: result.warnings,
        }));
        return;
      }
      console.log(`codegraph.binary: ${resolution.configured ?? '(none)'}`);
      console.log(`source: ${resolution.source}`);
      console.log(`effective command: ${resolution.command}`);
      console.log(`global_config: ${result.globalConfigPath} (${result.globalConfigExists ? 'exists' : 'absent'})`);
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
    });

  const codegraphMcp = codegraph
    .command('mcp')
    .description('Inspect and configure the existing upstream CodeGraph MCP server');

  codegraphMcp
    .command('self-test')
    .description('Verify the existing CodeGraph MCP server (codegraph serve --mcp) responds with the expected tools')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--timeout <ms>', 'Self-test timeout in milliseconds')
    .action(async (options: { repo: string; json?: boolean; timeout?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const timeoutMs = options.timeout !== undefined ? Number(options.timeout) : undefined;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        emitCliStructuredError(
          makeCliStructuredError(
            'INVALID_TIMEOUT',
            `invalid --timeout: ${options.timeout}`,
            '',
            ['Expected a positive integer number of milliseconds.'],
          ),
          { json: options.json, prefix: 'codegraph mcp self-test failed' },
        );
        return;
      }

      const result = await runCodeGraphMcpSelfTest({
        repoRoot,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });

      if (options.json) {
        const payload = {
          ok: result.ok,
          transport: result.transport,
          serverCommand: `${result.serverCommand} ${result.serverArgs.join(' ')}`.trim(),
          repoRoot: result.repoRoot,
          tools: result.tools,
          expectedToolsPresent: result.expectedToolsPresent,
          missingTools: result.missingTools,
          warnings: result.warnings,
          ...(result.error
            ? { error: { code: result.error.code, message: result.error.message } }
            : {}),
        };
        console.log(JSON.stringify(payload));
        if (!result.ok) process.exitCode = 1;
        return;
      }

      const serverDisplay = `${result.serverCommand} ${result.serverArgs.join(' ')}`.trim();
      if (result.ok) {
        console.log('CodeGraph MCP self-test: OK');
        console.log(`Server: ${serverDisplay}`);
        console.log(`Transport: ${result.transport}`);
        console.log(`Repo: ${result.repoRoot}`);
        console.log('Tools:');
        for (const tool of result.tools) console.log(`  - ${tool}`);
        if (result.warnings.length > 0) {
          console.log('Warnings:');
          for (const warning of result.warnings) console.log(`  - ${warning}`);
        } else {
          console.log('Warnings: none');
        }
        return;
      }

      console.error('CodeGraph MCP self-test: FAILED');
      console.error(`Server: ${serverDisplay}`);
      console.error(`Transport: ${result.transport}`);
      console.error(`Repo: ${result.repoRoot}`);
      if (result.error) {
        console.error(`error: ${result.error.code}: ${result.error.message}`);
      }
      if (result.missingTools.length > 0) {
        console.error('Missing tools:');
        for (const tool of result.missingTools) console.error(`  - ${tool}`);
      }
      if (result.warnings.length > 0) {
        console.error('Warnings:');
        for (const warning of result.warnings) console.error(`  - ${warning}`);
      }
      process.exitCode = 1;
    });

  codegraphMcp
    .command('config')
    .description('Print a CodeGraph MCP config snippet for the given agent (print-only)')
    .requiredOption('--agent <agent>', 'Target agent (e.g. claude)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--print', 'Print the config snippet (default behavior)')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { agent: string; repo: string; print?: boolean; json?: boolean }) => {
      const result = buildCodeGraphMcpAgentConfig(options.agent);
      if (!result.ok) {
        emitCliStructuredError(
          makeCliStructuredError(
            result.error.code,
            result.error.message,
            '',
            result.error.details,
          ),
          { json: options.json, prefix: 'codegraph mcp config failed' },
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            agent: result.agent,
            format: result.format,
            config: result.config,
            snippet: result.snippet,
          },
          artifacts: [],
          warnings: [],
        }));
        return;
      }

      console.log(`# CodeGraph MCP config for agent: ${result.agent}`);
      console.log(result.snippet);
    });

  registerCodeGraphQueryCommands(codegraph, dependencies);
}
