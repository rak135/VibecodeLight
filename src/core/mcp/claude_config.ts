import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { detectClaudeMcpConfig, type ClaudeMcpDetectionResult } from './claude_mcp_detect.js';

export type ClaudeMcpScope = 'local' | 'user' | 'project';

export const CLAUDE_MCP_SERVER_NAME = 'vibecode';

export const CLAUDE_FORBIDDEN_CONFIG_KEYS = [
  'default_tools_approval_mode',
  'approval',
  'approvals',
  'permissions',
  'allowedTools',
  'deniedTools',
  'hooks',
  'enabled_tools',
  'disabled_tools',
] as const;

export const CLAUDE_MCP_EXPECTED_TOOLS = [
  // Phase MCP-1: read-only CodeGraph tools.
  'vibecode_codegraph_status',
  'vibecode_codegraph_search',
  'vibecode_codegraph_context',
  'vibecode_codegraph_files',
  'vibecode_codegraph_callers',
  'vibecode_codegraph_callees',
  'vibecode_codegraph_impact',
  // Phase MCP-2: read-only run / artifact tools.
  'vibecode_runs_list',
  'vibecode_current_run',
  'vibecode_run_get',
  'vibecode_artifact_read',
  'vibecode_codegraph_usage',
  // Phase MCP-3: read-only workspace orientation tools.
  'vibecode_workspace_info',
  'vibecode_workspace_status',
  'vibecode_mcp_guidance',
  'vibecode_project_instructions',
  'vibecode_artifacts_list',
  // Phase Coordination-1: read-only multi-agent coordination status.
  'vibecode_coordination_status',
  // Phase Coordination-2: persistent agent session registry + heartbeat.
  // These write ONLY advisory generated state (.vibecode/coordination/state.json);
  // they never touch source files, the shell, git, or the terminal.
  'vibecode_agent_register',
  'vibecode_agent_heartbeat',
  'vibecode_agents_list',
  'vibecode_agent_status',
  // Phase Coordination-3A: advisory file claims.
  // These write ONLY advisory generated state (.vibecode/coordination/state.json);
  // they never touch source files, the shell, git, or the terminal.
  'vibecode_claim_add',
  'vibecode_claims_list',
  'vibecode_claim_status',
  'vibecode_claim_release',
  // Phase Coordination-4A: read-only agent-aware finalize check.
  // Read-only; classifies the working tree against advisory claims. Never
  // touches source files, the shell, git mutation, or the terminal.
  'vibecode_finalize_check',
] as const;

export interface ClaudeMcpServerConfig {
  type: 'stdio';
  command: 'node';
  args: string[];
  env: Record<string, never>;
}

export interface ClaudeMcpConfigOptions {
  repoRoot: string;
  scope?: ClaudeMcpScope;
  vibecodeBinPath?: string;
  claudeCommand?: string;
}

export interface ClaudeMcpConfigEnvelope {
  ok: true;
  data: {
    agent: 'claude';
    scope: ClaudeMcpScope;
    server_name: 'vibecode';
    server_config: ClaudeMcpServerConfig;
    claude_command: string;
    claude_args: string[];
    warnings: string[];
  };
}

export interface ClaudeMcpInstallCommand {
  command: string;
  args: string[];
  cwd: string;
  scope: ClaudeMcpScope;
  server_name: 'vibecode';
  server_config: ClaudeMcpServerConfig;
  warnings: string[];
  display_command: string;
}

export type ClaudeMcpErrorCode =
  | 'INVALID_AGENT'
  | 'INVALID_SCOPE'
  | 'REPO_NOT_FOUND'
  | 'REPO_NOT_A_DIRECTORY'
  | 'CLAUDE_CLI_NOT_FOUND'
  | 'CLAUDE_MCP_INSTALL_FAILED'
  | 'CLAUDE_MCP_FORBIDDEN_KEY'
  | 'CLAUDE_MCP_DOCTOR_FAILED'
  | 'VIBECODE_MCP_NOT_AVAILABLE'
  | 'MCP_CONFIG_BUILD_FAILED';

export interface ClaudeMcpError {
  code: ClaudeMcpErrorCode;
  message: string;
  path?: string;
  details?: string[];
}

export interface ClaudeProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type ClaudeProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => ClaudeProcessResult;

export interface ClaudeMcpInstallOptions extends ClaudeMcpConfigOptions {
  dryRun?: boolean;
  yes?: boolean;
  runner?: ClaudeProcessRunner;
  timeoutMs?: number;
  /** Builder seam (defaults to buildClaudeMcpInstallCommand); used to exercise the forbidden-key guard. */
  buildInstallCommand?: (options: ClaudeMcpConfigOptions) => ClaudeMcpInstallCommand;
}

export type ClaudeMcpInstallResult =
  | {
      ok: true;
      agent: 'claude';
      scope: ClaudeMcpScope;
      server_name: 'vibecode';
      server_config: ClaudeMcpServerConfig;
      claude_command: string;
      claude_args: string[];
      cwd: string;
      planned_command: string;
      dry_run: boolean;
      stdout: string;
      stderr: string;
      warnings: string[];
      restart_required: true;
    }
  | {
      ok: false;
      error: ClaudeMcpError;
      stdout?: string;
      stderr?: string;
      warnings: string[];
    };

export interface ClaudeDoctorOptions extends ClaudeMcpConfigOptions {
  runner?: ClaudeProcessRunner;
  timeoutMs?: number;
  toolsProvider?: () => { ok: true; tools: string[] } | { ok: false; error: string };
  /** Directory holding Claude's `.claude.json`; defaults to CLAUDE_CONFIG_DIR or the user home. */
  claudeConfigDir?: string;
  /** Environment used for config-dir resolution in read-only detection. */
  env?: Record<string, string | undefined>;
}

export interface ClaudeDoctorResult {
  ok: boolean;
  agent: 'claude';
  scope: ClaudeMcpScope;
  server_name: 'vibecode';
  checks: Record<string, { ok: boolean; message: string }>;
  warnings: string[];
  suggestions: string[];
  error?: ClaudeMcpError;
}

export function parseClaudeMcpScope(value: string | undefined): ClaudeMcpScope | null {
  if (value === undefined || value.trim() === '') return 'local';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'user' || normalized === 'project') return normalized;
  return null;
}

export function normalizeMcpPath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/');
}

export function resolveDefaultVibecodeBinPath(startDir = __dirname): string {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, 'bin', 'vibecode.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve('bin', 'vibecode.js');
    current = parent;
  }
}

export function buildClaudeMcpConfig(options: ClaudeMcpConfigOptions): ClaudeMcpConfigEnvelope {
  const command = buildClaudeMcpInstallCommand(options);
  return {
    ok: true,
    data: {
      agent: 'claude',
      scope: command.scope,
      server_name: command.server_name,
      server_config: command.server_config,
      claude_command: command.command,
      claude_args: command.args,
      warnings: command.warnings,
    },
  };
}

export function buildClaudeMcpInstallCommand(options: ClaudeMcpConfigOptions): ClaudeMcpInstallCommand {
  const scope = options.scope ?? 'local';
  const repoRoot = normalizeMcpPath(options.repoRoot);
  const vibecodeBinPath = normalizeMcpPath(options.vibecodeBinPath ?? resolveDefaultVibecodeBinPath());
  const serverConfig: ClaudeMcpServerConfig = {
    type: 'stdio',
    command: 'node',
    args: [
      vibecodeBinPath,
      'mcp',
      'serve',
      '--repo',
      repoRoot,
      '--codegraph-transport',
      'auto',
      '--log-level',
      'warn',
    ],
    env: {},
  };
  const warnings = claudeScopeWarnings(scope);
  const args = [
    'mcp',
    'add-json',
    CLAUDE_MCP_SERVER_NAME,
    JSON.stringify(serverConfig),
    '--scope',
    scope,
  ];

  return {
    command: options.claudeCommand ?? 'claude',
    args,
    cwd: repoRoot,
    scope,
    server_name: CLAUDE_MCP_SERVER_NAME,
    server_config: serverConfig,
    warnings,
    display_command: `claude mcp add-json ${CLAUDE_MCP_SERVER_NAME} <server-json> --scope ${scope}`,
  };
}

/**
 * Recursively collect any object KEYS in `payload` that match
 * {@link CLAUDE_FORBIDDEN_CONFIG_KEYS} (approval/permission/tool-policy keys
 * Vibecode must never write). Recurses through plain objects and arrays.
 *
 * Matching is on keys only and case-insensitive — string VALUES that merely
 * contain the same words (e.g. an arg that mentions "allowedTools") are not
 * flagged. This is the fail-closed production guard behind the Claude install
 * payload: if a future edit ever adds such a key, install aborts before
 * spawning Claude rather than silently passing it to `claude mcp add-json`.
 */
export function findForbiddenClaudeConfigKeys(payload: unknown): string[] {
  const forbidden = new Set(CLAUDE_FORBIDDEN_CONFIG_KEYS.map((key) => key.toLowerCase()));
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.has(key.toLowerCase()) && !found.includes(key)) found.push(key);
      visit(child);
    }
  };
  visit(payload);
  return found;
}

export function applyClaudeMcpInstall(options: ClaudeMcpInstallOptions): ClaudeMcpInstallResult {
  const buildCommand = options.buildInstallCommand ?? buildClaudeMcpInstallCommand;
  const command = buildCommand(options);
  const warnings = [
    ...command.warnings,
    'Vibecode does not manage Claude MCP approvals. Claude Code applies its own permission/trust settings.',
  ];

  // Fail closed: never pass an approval/permission/tool-policy key to Claude,
  // even if a future change accidentally introduces one into the payload.
  const forbiddenKeys = findForbiddenClaudeConfigKeys(command.server_config);
  if (forbiddenKeys.length > 0) {
    return {
      ok: false,
      error: {
        code: 'CLAUDE_MCP_FORBIDDEN_KEY',
        message: `Refusing to install: Claude MCP payload contains forbidden approval/permission keys: ${forbiddenKeys.join(', ')}.`,
        path: command.cwd,
        details: [
          `Forbidden keys: ${forbiddenKeys.join(', ')}`,
          'Vibecode registers MCP servers/tools but does not manage Claude approval or permission policy.',
          'No Claude config was modified.',
        ],
      },
      warnings,
    };
  }

  if (!options.dryRun && !options.yes) {
    return {
      ok: false,
      error: {
        code: 'CLAUDE_MCP_INSTALL_FAILED',
        message: 'Refusing to run Claude MCP install without --yes. Use --dry-run to preview or --yes to install.',
        path: command.cwd,
        details: ['No Claude config was modified.'],
      },
      warnings,
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      agent: 'claude',
      scope: command.scope,
      server_name: command.server_name,
      server_config: command.server_config,
      claude_command: command.command,
      claude_args: command.args,
      cwd: command.cwd,
      planned_command: command.display_command,
      dry_run: true,
      stdout: '',
      stderr: '',
      warnings,
      restart_required: true,
    };
  }

  const runner = options.runner ?? runDefaultClaudeProcess;
  const result = runner(command.command, command.args, {
    cwd: path.resolve(options.repoRoot),
    timeoutMs: options.timeoutMs ?? 30000,
  });
  const stdout = boundText(result.stdout);
  const stderr = boundText(result.stderr);

  if (result.error) {
    return {
      ok: false,
      error: {
        code: 'CLAUDE_CLI_NOT_FOUND',
        message: result.error.message,
        path: command.cwd,
        details: ['Unable to run `claude --version` or `claude mcp add-json`; install Claude Code CLI and retry.'],
      },
      stdout,
      stderr,
      warnings,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      error: {
        code: 'CLAUDE_MCP_INSTALL_FAILED',
        message: stderr || stdout || `Claude MCP install failed with exit code ${result.status ?? 'unknown'}.`,
        path: command.cwd,
        details: [`Command: ${command.display_command}`],
      },
      stdout,
      stderr,
      warnings,
    };
  }

  return {
    ok: true,
    agent: 'claude',
    scope: command.scope,
    server_name: command.server_name,
    server_config: command.server_config,
    claude_command: command.command,
    claude_args: command.args,
    cwd: command.cwd,
    planned_command: command.display_command,
    dry_run: false,
    stdout,
    stderr,
    warnings,
    restart_required: true,
  };
}

export function runClaudeMcpDoctor(options: ClaudeDoctorOptions): ClaudeDoctorResult {
  const command = buildClaudeMcpInstallCommand(options);
  const runner = options.runner ?? runDefaultClaudeProcess;
  const warnings = [
    ...command.warnings,
    'Vibecode does not manage Claude MCP approvals. Claude Code applies its own permission/trust settings.',
  ];
  const suggestions = ['Restart Claude Code or run /mcp inside Claude Code to inspect connected servers.'];
  const checks: ClaudeDoctorResult['checks'] = {};

  const version = runner(command.command, ['--version'], { cwd: path.resolve(options.repoRoot), timeoutMs: options.timeoutMs ?? 10000 });
  checks.claude_cli = {
    ok: !version.error && version.status === 0,
    message: !version.error && version.status === 0
      ? `Claude CLI is available: ${boundText(version.stdout).trim() || 'version returned'}`
      : fallbackMessage(version.error?.message, boundText(version.stderr), 'Claude CLI is not available.'),
  };
  if (!checks.claude_cli.ok) {
    return {
      ok: false,
      agent: 'claude',
      scope: command.scope,
      server_name: command.server_name,
      checks,
      warnings,
      suggestions,
      error: {
        code: 'CLAUDE_CLI_NOT_FOUND',
        message: checks.claude_cli.message,
        path: command.cwd,
      },
    };
  }

  const toolsResult = options.toolsProvider?.() ?? runDefaultToolsProvider(command.server_config.args[0]);
  checks.tools = {
    ok: toolsResult.ok && sameSet(toolsResult.tools, CLAUDE_MCP_EXPECTED_TOOLS),
    message: toolsResult.ok ? 'vibecode mcp tools exposes the expected read-only tools.' : toolsResult.error,
  };
  if (!checks.tools.ok) warnings.push('VibecodeMCP tools are not available or differ from the expected read-only tool list.');

  const list = runner(command.command, ['mcp', 'list'], { cwd: path.resolve(options.repoRoot), timeoutMs: options.timeoutMs ?? 10000 });
  checks.claude_mcp_list = {
    ok: !list.error && list.status === 0,
    message: !list.error && list.status === 0
      ? 'Claude MCP server list was inspected.'
      : fallbackMessage(list.error?.message, boundText(list.stderr), 'claude mcp list failed.'),
  };
  collectApprovalWarnings(`${list.stdout}\n${list.stderr}`, warnings);

  const get = runner(command.command, ['mcp', 'get', CLAUDE_MCP_SERVER_NAME], { cwd: path.resolve(options.repoRoot), timeoutMs: options.timeoutMs ?? 10000 });
  const serverVisible = !get.error && get.status === 0;
  checks.claude_mcp_get = {
    ok: serverVisible,
    message: serverVisible
      ? 'Claude reports a `vibecode` MCP server for this scope/project.'
      : fallbackMessage(get.error?.message, boundText(get.stderr), '`claude mcp get vibecode` did not find the server.'),
  };
  collectApprovalWarnings(`${get.stdout}\n${get.stderr}`, warnings);

  // Authoritative binding check: read-only detection of the configured server
  // across local/project/user scopes. Exit-code visibility from `mcp get` is
  // kept as a liveness signal only — it cannot tell us whether the configured
  // server points at THIS repo with the current serve command/args.
  const detection = detectClaudeMcpConfig({
    repoRoot: options.repoRoot,
    vibecodeBinPath: options.vibecodeBinPath,
    env: options.env,
    claudeConfigDir: options.claudeConfigDir,
  });
  warnings.push(...detection.warnings);
  checks.server_binding = buildServerBindingCheck(detection);
  if (!checks.server_binding.ok) warnings.push(checks.server_binding.message);

  const ok = checks.claude_cli.ok && checks.tools.ok && checks.server_binding.ok;
  return {
    ok,
    agent: 'claude',
    scope: command.scope,
    server_name: command.server_name,
    checks,
    warnings: dedupe(warnings),
    suggestions,
    ...(ok
      ? {}
      : {
          error: {
            code: 'CLAUDE_MCP_DOCTOR_FAILED' as const,
            message: 'Claude MCP doctor found one or more failed checks.',
            path: command.cwd,
          },
        }),
  };
}

/**
 * Translate read-only detection into the doctor's `server_binding` check. This
 * distinguishes the four states the doctor must report: missing, wrong-repo,
 * stale command/args, and up-to-date.
 */
function buildServerBindingCheck(detection: ClaudeMcpDetectionResult): { ok: boolean; message: string } {
  if (!detection.configured) {
    return {
      ok: false,
      message:
        'No configured `vibecode` MCP server was found in Claude local/project/user config for this repo. Run `vibecode mcp install --agent claude --repo <path> --yes`.',
    };
  }
  const effective = detection.effective;
  const scope = effective?.scope ?? 'unknown';
  if (detection.status === 'up_to_date') {
    return {
      ok: true,
      message: `Configured \`vibecode\` MCP server (${scope} scope) is up to date and matches this repo and serve command.`,
    };
  }
  if (effective && effective.matches_repo === false) {
    return {
      ok: false,
      message: `Configured \`vibecode\` MCP server (${scope} scope) is bound to a different repo: ${effective.repo_binding ?? 'unknown'}. Re-run install for this repo.`,
    };
  }
  return {
    ok: false,
    message: `Configured \`vibecode\` MCP server (${scope} scope) command/args are stale versus the current \`vibecode mcp serve\` invocation. Re-run install to update.`,
  };
}

function claudeScopeWarnings(scope: ClaudeMcpScope): string[] {
  if (scope === 'project') {
    return [
      'Project scope writes project-shared Claude MCP config in .mcp.json; this file may be committed.',
      'Claude Code may require project server approval/trust for project-scoped MCP servers.',
    ];
  }
  if (scope === 'user') {
    return ['User scope is global across projects, but this VibecodeMCP server remains repo-bound to the provided --repo path.'];
  }
  return [];
}

/** Resolves a bare command name to a concrete executable. Returns null when unresolved. */
export type ClaudeExecutableResolver = (command: string) => string | null;

export interface ClaudeSpawnInvocation {
  /** Executable to spawn (the command, a resolved path, or the system shell). */
  file: string;
  /** Argument vector — always a real array, never a concatenated shell string. */
  args: string[];
  /** Always false: we never hand arguments to a shell for interpretation. */
  shell: false;
  /** True only for the cmd.exe verbatim path on Windows. */
  windowsVerbatimArguments: boolean;
}

/**
 * Quote a single argument for a cmd.exe verbatim command line. cmd.exe accepts
 * a doubled double-quote (`""`) as a literal quote inside a quoted token, which
 * lets a JSON payload (full of `"`) survive intact when passed to a `.cmd`
 * shim. Verified to round-trip `claude mcp add-json <json>` through a real
 * `node cli %*` batch shim.
 */
function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Resolve a command to a concrete Windows executable via `where`. Returns the
 * first match (typically `claude.cmd` for an npm-installed Claude CLI), or null
 * when the command cannot be found on PATH.
 */
function resolveWindowsExecutable(command: string): string | null {
  // Already an explicit path to a known executable type — use it as-is.
  if (/[\\/]/.test(command) && /\.(cmd|bat|exe)$/i.test(command)) return command;
  const result = spawnSync('where', [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? null;
}

/**
 * Decide exactly how to spawn the Claude CLI.
 *
 * POSIX: spawn the bare command; the OS resolves it on PATH. No shell.
 *
 * Windows: Node (post the batch CVE fix) refuses to run a `.cmd`/`.bat` with
 * `shell:false` (EINVAL), and `shell:true` concatenates — and thereby corrupts
 * — the JSON argument that `claude mcp add-json` requires. So we resolve the
 * executable and route a `.cmd`/`.bat` shim through `cmd.exe /d /s /c "<line>"`
 * with `windowsVerbatimArguments` and explicit quoting we control. A resolved
 * `.exe` is spawned directly. An unresolved command falls back to the bare name
 * so the spawn surfaces a clean ENOENT (→ CLAUDE_CLI_NOT_FOUND). Shell is never
 * enabled, so there is no shell-injection surface.
 */
export function buildClaudeSpawnInvocation(opts: {
  command: string;
  args: string[];
  platform?: typeof process.platform;
  env?: Record<string, string | undefined>;
  resolveExecutable?: ClaudeExecutableResolver;
}): ClaudeSpawnInvocation {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    return { file: opts.command, args: opts.args, shell: false, windowsVerbatimArguments: false };
  }

  const resolve = opts.resolveExecutable ?? resolveWindowsExecutable;
  const resolved = resolve(opts.command);

  if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
    const env = opts.env ?? process.env;
    const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
    const line = [resolved, ...opts.args].map(quoteCmdArg).join(' ');
    // cmd /s strips the first and last quote of the whole string; wrap it.
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], shell: false, windowsVerbatimArguments: true };
  }

  // Resolved .exe (or any non-batch), or unresolved: spawn directly, no shell.
  return { file: resolved ?? opts.command, args: opts.args, shell: false, windowsVerbatimArguments: false };
}

function runDefaultClaudeProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number }): ClaudeProcessResult {
  const invocation = buildClaudeSpawnInvocation({ command, args });
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: invocation.shell,
    windowsHide: true,
    timeout: options.timeoutMs,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function runDefaultToolsProvider(vibecodeBinPath: string): { ok: true; tools: string[] } | { ok: false; error: string } {
  const result = spawnSync('node', [path.resolve(vibecodeBinPath), 'mcp', 'tools', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: result.stderr || result.stdout || `exit ${result.status}` };
  try {
    const parsed = JSON.parse(result.stdout) as { data?: { tools?: string[] } };
    const tools = parsed.data?.tools;
    return Array.isArray(tools) ? { ok: true, tools } : { ok: false, error: 'tools JSON did not contain data.tools.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function boundText(value: string, max = 4096): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 32)}\n[truncated ${value.length - (max - 32)} chars]`;
}

function fallbackMessage(...values: Array<string | undefined>): string {
  return values.find((value) => value !== undefined && value.trim().length > 0) ?? '';
}

function collectApprovalWarnings(text: string, warnings: string[]): void {
  if (/pending approval|pending trust|rejected/i.test(text)) {
    warnings.push('Claude reports the Vibecode MCP server as pending approval/trust or rejected. Vibecode does not resolve Claude approvals; run /mcp inside Claude Code.');
  }
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
