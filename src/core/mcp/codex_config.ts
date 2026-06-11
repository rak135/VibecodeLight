import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type McpAgent = 'codex';
export type McpConfigScope = 'user' | 'project';

export const CODEX_MCP_SERVER_NAME = 'vibecode';

/**
 * Maximum number of timestamped Codex config backups (`config.toml.bak.<ts>`)
 * retained per config file. Older backups for the same config are pruned after
 * a successful install so repeated installs do not accumulate forever.
 */
export const CODEX_CONFIG_BACKUP_LIMIT = 5;

export const CODEX_MCP_ENABLED_TOOLS = [
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
  // Phase 1B-2: read-only bounded scan summary + allowlisted scan artifact reads.
  // Both read existing scan artifacts only; neither runs the scanner, touches
  // source files, the shell, git, or the terminal.
  'vibecode_scan_summary',
  'vibecode_scan_artifact_read',
  // Phase MCP-3: read-only workspace orientation tools.
  'vibecode_workspace_info',
  'vibecode_workspace_status',
  'vibecode_mcp_guidance',
  'vibecode_project_instructions',
  'vibecode_artifacts_list',
  // Phase 1B-3: named recommended tool sets (static, read-only).
  'vibecode_tool_profile',
  // Phase 1A: one-call session bootstrap + claim-aware git changes.
  // session_bootstrap writes ONLY advisory generated state when asked to
  // register/heartbeat; git_changes is read-only. Neither touches source files,
  // the shell, git mutation, or the terminal.
  'vibecode_session_bootstrap',
  'vibecode_git_changes',
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
  // Phase 2A: agent-declared work scope — claim plan (read-only) + explicit bulk
  // claim. These write ONLY advisory generated state; they never touch source
  // files, the shell, git, or the terminal, and never infer/expand paths.
  'vibecode_claims_plan',
  'vibecode_claims_add_bulk',
  // Phase 2B: claim intent lifecycle — list (read-only) + release (same-agent,
  // blocked on dirty files). Write ONLY advisory generated state.
  'vibecode_claim_intents_list',
  'vibecode_claim_intent_release',
  // Phase Coordination-4A: read-only agent-aware finalize check.
  // Read-only; classifies the working tree against advisory claims. Never
  // touches source files, the shell, git mutation, or the terminal.
  'vibecode_finalize_check',
  // Phase Coordination-4C: watcher evidence.
  // list is read-only; scan writes ONLY generated advisory state
  // (.vibecode/coordination/events.jsonl). Neither touches source files, the
  // shell, git mutation, or the terminal.
  'vibecode_evidence_list',
  'vibecode_evidence_scan',
  // Phase Coordination-4D-cleanup: claims reap + conflict history.
  'vibecode_claims_reap',
  'vibecode_conflicts_list',
  'vibecode_conflict_resolve',
  // Phase 2D: intent-aware conflict triage detail (read-only).
  'vibecode_conflict_detail',
  // Phase 4A: read-only handoff packet (visibility only; no ownership transfer).
  'vibecode_handoff_prepare',
] as const;

export type CodexMcpToolName = typeof CODEX_MCP_ENABLED_TOOLS[number];

export interface CodexMcpConfigOptions {
  repoRoot: string;
  scope?: McpConfigScope;
  configPath?: string;
  codexHome?: string;
  vibecodeBinPath?: string;
}

export interface CodexMcpConfigEnvelope {
  ok: true;
  agent: 'codex';
  scope: McpConfigScope;
  config_path: string;
  server_name: 'vibecode';
  command: 'node';
  args: string[];
  cwd: string;
  enabled_tools: string[];
  toml_snippet: string;
  warnings: string[];
}

export interface CodexConfigPathResult {
  scope: McpConfigScope;
  configPath: string;
  warnings: string[];
}

export type McpConfigErrorCode =
  | 'CODEX_CONFIG_NOT_FOUND'
  | 'CODEX_CONFIG_INVALID'
  | 'CODEX_CONFIG_WRITE_FAILED'
  | 'CODEX_MCP_SERVER_EXISTS'
  | 'VIBECODE_MCP_NOT_AVAILABLE'
  | 'INVALID_AGENT'
  | 'INVALID_SCOPE'
  | 'REPO_NOT_FOUND'
  | 'REPO_NOT_A_DIRECTORY';

export interface McpConfigError {
  code: McpConfigErrorCode;
  message: string;
  path?: string;
  details?: string[];
}

export interface CodexInstallOptions extends CodexMcpConfigOptions {
  dryRun?: boolean;
  yes?: boolean;
  /** Validates the fully patched TOML before it overwrites the config. Defaults to {@link validateCodexConfigToml}. */
  validateToml?: (text: string) => { ok: true } | { ok: false; error: string };
  /** Platform override for permission hardening. Defaults to process.platform. */
  platform?: typeof process.platform;
  /** chmod implementation seam (POSIX hardening). Defaults to fs.chmodSync. */
  chmod?: (path: string, mode: number) => void;
}

export type CodexInstallResult =
  | {
      ok: true;
      agent: 'codex';
      scope: McpConfigScope;
      config_path: string;
      server_name: 'vibecode';
      action: 'create' | 'update';
      existing_server: boolean;
      dry_run: boolean;
      backup_path: string | null;
      planned_toml_snippet: string;
      toml_snippet: string;
      warnings: string[];
      restart_required: true;
    }
  | {
      ok: false;
      error: McpConfigError;
      warnings: string[];
    };

export interface TomlPatchResult {
  next: string;
  existed: boolean;
}

export interface CodexDoctorOptions extends CodexMcpConfigOptions {
  codexExecutableChecker?: () => boolean;
  toolsProvider?: () => { ok: true; tools: string[] } | { ok: false; error: string };
}

export interface CodexDoctorResult {
  ok: boolean;
  agent: 'codex';
  scope: McpConfigScope;
  config_path: string;
  server_name: 'vibecode';
  checks: Record<string, { ok: boolean; message: string }>;
  warnings: string[];
  suggestions: string[];
  error?: McpConfigError;
}

export function normalizeTomlPath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/');
}

export function parseMcpAgent(value: string | undefined): McpAgent | null {
  return value?.trim().toLowerCase() === 'codex' ? 'codex' : null;
}

export function parseMcpScope(value: string | undefined): McpConfigScope | null {
  if (value === undefined || value.trim() === '') return 'user';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'user' || normalized === 'project') return normalized;
  return null;
}

export function resolveCodexConfigPath(options: CodexMcpConfigOptions): CodexConfigPathResult {
  const scope = options.scope ?? 'user';
  if (options.configPath) {
    return { scope, configPath: path.resolve(options.configPath), warnings: [] };
  }

  if (scope === 'project') {
    return {
      scope,
      configPath: path.join(path.resolve(options.repoRoot), '.codex', 'config.toml'),
      warnings: ['Codex loads project .codex/config.toml only for trusted projects.'],
    };
  }

  const home = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return { scope, configPath: path.join(path.resolve(home), 'config.toml'), warnings: [] };
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

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/g, '/'));
}

function tomlArray(values: readonly string[], indent = ''): string {
  const lines = ['['];
  for (const value of values) {
    lines.push(`${indent}  ${tomlString(value)},`);
  }
  lines.push(`${indent}]`);
  return lines.join('\n');
}

export function buildCodexMcpConfig(options: CodexMcpConfigOptions): CodexMcpConfigEnvelope {
  const repoRoot = normalizeTomlPath(options.repoRoot);
  const scope = options.scope ?? 'user';
  const pathInfo = resolveCodexConfigPath({ ...options, scope });
  const vibecodeBinPath = normalizeTomlPath(options.vibecodeBinPath ?? resolveDefaultVibecodeBinPath());
  const args = [
    vibecodeBinPath,
    'mcp',
    'serve',
    '--repo',
    repoRoot,
    '--codegraph-transport',
    'auto',
    '--log-level',
    'warn',
  ];

  const tomlSnippet = [
    '[mcp_servers.vibecode]',
    'command = "node"',
    `args = ${tomlArray(args)}`,
    `cwd = ${tomlString(repoRoot)}`,
    'enabled = true',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    `enabled_tools = ${tomlArray(CODEX_MCP_ENABLED_TOOLS)}`,
    // Vibecode registers the MCP server and its read-only tools but does NOT
    // manage Codex approval policy. We intentionally do not write
    // default_tools_approval_mode (or any approval/permission key); approval
    // behavior belongs to Codex (`/mcp`). See docs/codegraph.md.
    '',
  ].join('\n');

  return {
    ok: true,
    agent: 'codex',
    scope,
    config_path: normalizeTomlPath(pathInfo.configPath),
    server_name: CODEX_MCP_SERVER_NAME,
    command: 'node',
    args,
    cwd: repoRoot,
    enabled_tools: [...CODEX_MCP_ENABLED_TOOLS],
    toml_snippet: tomlSnippet,
    warnings: pathInfo.warnings,
  };
}

export function patchTomlTableBlock(source: string, tableName: string, replacementBlock: string): TomlPatchResult {
  const normalizedReplacement = replacementBlock.trimEnd();
  const headerPattern = new RegExp(`^\\s*\\[${escapeRegExp(tableName)}\\]\\s*(?:#.*)?$`, 'm');
  const match = headerPattern.exec(source);
  if (!match || match.index === undefined) {
    const separator = source.trimEnd().length > 0 ? '\n\n' : '';
    return { existed: false, next: `${source.trimEnd()}${separator}${normalizedReplacement}\n` };
  }

  const start = match.index;
  const afterHeader = start + match[0].length;
  const nextTablePattern = /^\s*\[[^\]]+\]\s*(?:#.*)?$/gm;
  nextTablePattern.lastIndex = afterHeader;
  const nextMatch = nextTablePattern.exec(source);
  const end = nextMatch?.index ?? source.length;
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(end).replace(/^\s*\n/, '');
  const next = [
    before,
    normalizedReplacement,
    after.trimStart(),
  ].filter((part) => part.length > 0).join('\n\n');
  return { existed: true, next: `${next.trimEnd()}\n` };
}

export function extractTomlTableBlock(source: string, tableName: string): string | null {
  const patched = patchTomlTableBlock(source, tableName, `[${tableName}]\n__marker = true`);
  if (!patched.existed) return null;
  const headerPattern = new RegExp(`^\\s*\\[${escapeRegExp(tableName)}\\]\\s*(?:#.*)?$`, 'm');
  const match = headerPattern.exec(source);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const nextTablePattern = /^\s*\[[^\]]+\]\s*(?:#.*)?$/gm;
  nextTablePattern.lastIndex = start + match[0].length;
  const nextMatch = nextTablePattern.exec(source);
  return source.slice(start, nextMatch?.index ?? source.length);
}

/**
 * Best-effort structural validation of the fully patched Codex config before it
 * is written. A real TOML parser is not a project dependency, so this verifies
 * the invariants this installer is responsible for — exactly one well-formed
 * `[mcp_servers.vibecode]` table carrying the keys we write. This catches the
 * corruption a patching bug would introduce (missing/duplicated table, snippet
 * merged into the wrong place) without false-positiving on otherwise valid but
 * exotic user TOML elsewhere in the file. Callers may inject a stricter
 * validator via {@link CodexInstallOptions.validateToml}.
 */
export function validateCodexConfigToml(text: string): { ok: true } | { ok: false; error: string } {
  const headers = text.match(/^\s*\[mcp_servers\.vibecode\]\s*(?:#.*)?$/gm);
  if (!headers || headers.length === 0) {
    return { ok: false, error: 'patched config is missing the [mcp_servers.vibecode] table' };
  }
  if (headers.length > 1) {
    return { ok: false, error: `patched config has ${headers.length} [mcp_servers.vibecode] tables; expected exactly one` };
  }
  const block = extractTomlTableBlock(text, 'mcp_servers.vibecode');
  if (!block) {
    return { ok: false, error: 'patched [mcp_servers.vibecode] table could not be extracted' };
  }
  for (const key of ['command', 'args', 'enabled_tools'] as const) {
    if (!new RegExp(`^\\s*${key}\\s*=`, 'm').test(block)) {
      return { ok: false, error: `patched [mcp_servers.vibecode] table is missing ${key}` };
    }
  }
  return { ok: true };
}

/**
 * Delete timestamped backups for a single config file beyond the retention
 * limit, keeping the newest {@link CODEX_CONFIG_BACKUP_LIMIT}. Only files named
 * `<basename>.bak.<...>` for THIS exact config path are considered; unrelated
 * files and backups of other configs are never touched. Best-effort: failures
 * to read the directory or unlink a file are swallowed so pruning never turns a
 * successful install into a reported failure.
 */
function pruneCodexBackups(configPath: string, limit: number): void {
  const dir = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.bak.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const backups = entries.filter((name) => name.startsWith(prefix)).sort();
  // Names embed an ISO timestamp (lexicographically sortable); newest last.
  const stale = backups.slice(0, Math.max(0, backups.length - limit));
  for (const name of stale) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Best-effort: leaving an extra backup is preferable to failing install.
    }
  }
}

export function applyCodexMcpInstall(options: CodexInstallOptions): CodexInstallResult {
  const config = buildCodexMcpConfig(options);
  const configPath = normalizeNativePath(config.config_path);
  const exists = fs.existsSync(configPath);
  const current = exists ? fs.readFileSync(configPath, 'utf8') : '';
  const patch = patchTomlTableBlock(current, 'mcp_servers.vibecode', config.toml_snippet);
  const action = patch.existed ? 'update' : 'create';

  if (!options.dryRun && !options.yes) {
    return {
      ok: false,
      error: {
        code: 'CODEX_CONFIG_WRITE_FAILED',
        message: 'Refusing to write Codex config without --yes. Use --dry-run to preview or --yes to install.',
        path: config.config_path,
        details: ['No files were written.'],
      },
      warnings: config.warnings,
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      agent: 'codex',
      scope: config.scope,
      config_path: config.config_path,
      server_name: 'vibecode',
      action,
      existing_server: patch.existed,
      dry_run: true,
      backup_path: null,
      planned_toml_snippet: config.toml_snippet,
      toml_snippet: config.toml_snippet,
      warnings: config.warnings,
      restart_required: true,
    };
  }

  // Validate the fully patched TOML before touching the filesystem. A patch bug
  // or unexpected existing shape must never overwrite the user's config.
  const validateToml = options.validateToml ?? validateCodexConfigToml;
  const validation = validateToml(patch.next);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: 'CODEX_CONFIG_INVALID',
        message: `Refusing to write Codex config: the patched TOML failed validation (${validation.error}).`,
        path: config.config_path,
        details: ['No files were written.', 'The existing Codex config was left unchanged.'],
      },
      warnings: config.warnings,
    };
  }

  const platform = options.platform ?? process.platform;
  const chmod = options.chmod ?? fs.chmodSync;
  const hardenPerms = (target: string): void => {
    if (platform === 'win32') return; // Do not fake POSIX permissions on Windows.
    try {
      chmod(target, 0o600);
    } catch {
      // Permission hardening is best-effort; never fail an otherwise-good write.
    }
  };

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let backupPath: string | null = null;
    if (exists) {
      backupPath = `${configPath}.bak.${timestampForBackup()}`;
      fs.copyFileSync(configPath, backupPath);
      hardenPerms(backupPath);
    }
    const tempPath = `${configPath}.tmp.${process.pid}`;
    fs.writeFileSync(tempPath, patch.next, 'utf8');
    // chmod the temp file before rename so the final config inherits 0600.
    hardenPerms(tempPath);
    fs.renameSync(tempPath, configPath);
    // Only after a safe write do we prune older backups for this config.
    pruneCodexBackups(configPath, CODEX_CONFIG_BACKUP_LIMIT);
    return {
      ok: true,
      agent: 'codex',
      scope: config.scope,
      config_path: config.config_path,
      server_name: 'vibecode',
      action,
      existing_server: patch.existed,
      dry_run: false,
      backup_path: backupPath ? normalizeTomlPath(backupPath) : null,
      planned_toml_snippet: config.toml_snippet,
      toml_snippet: config.toml_snippet,
      warnings: config.warnings,
      restart_required: true,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'CODEX_CONFIG_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        path: config.config_path,
        details: ['Failed while writing Codex config.'],
      },
      warnings: config.warnings,
    };
  }
}

export function runCodexMcpDoctor(options: CodexDoctorOptions): CodexDoctorResult {
  const config = buildCodexMcpConfig(options);
  const configPath = normalizeNativePath(config.config_path);
  const warnings = [...config.warnings];
  const suggestions = ['Restart or reload Codex, then run /mcp inside the Codex TUI to inspect connected servers.'];
  const checks: CodexDoctorResult['checks'] = {};

  const commandCheck = fs.existsSync(normalizeNativePath(config.args[0]));
  checks.command = {
    ok: commandCheck,
    message: commandCheck ? 'Vibecode CLI command path exists.' : `Vibecode CLI command path was not found: ${config.args[0]}`,
  };
  if (!commandCheck) warnings.push(checks.command.message);

  const toolsResult = options.toolsProvider?.() ?? runDefaultToolsProvider(config.args[0]);
  checks.tools = {
    ok: toolsResult.ok && sameSet(toolsResult.tools, CODEX_MCP_ENABLED_TOOLS),
    message: toolsResult.ok ? 'vibecode mcp tools exposes the expected tools.' : toolsResult.error,
  };
  if (!checks.tools.ok) warnings.push('VibecodeMCP tools are not available or differ from the expected read-only tool list.');

  if (!fs.existsSync(configPath)) {
    checks.configured = { ok: false, message: 'Codex config file was not found.' };
    return {
      ok: false,
      agent: 'codex',
      scope: config.scope,
      config_path: config.config_path,
      server_name: 'vibecode',
      checks,
      warnings,
      suggestions,
      error: { code: 'CODEX_CONFIG_NOT_FOUND', message: 'Codex config file was not found.', path: config.config_path },
    };
  }

  const text = fs.readFileSync(configPath, 'utf8');
  const block = extractTomlTableBlock(text, 'mcp_servers.vibecode');
  checks.configured = {
    ok: block !== null,
    message: block ? 'Codex config contains [mcp_servers.vibecode].' : 'Codex config does not contain [mcp_servers.vibecode].',
  };
  if (!block) {
    return {
      ok: false,
      agent: 'codex',
      scope: config.scope,
      config_path: config.config_path,
      server_name: 'vibecode',
      checks,
      warnings,
      suggestions,
      error: { code: 'CODEX_CONFIG_NOT_FOUND', message: checks.configured.message, path: config.config_path },
    };
  }

  const configuredTools = parseTomlStringArray(block, 'enabled_tools');
  const enabledToolsOk = configuredTools !== null && sameSet(configuredTools, CODEX_MCP_ENABLED_TOOLS);
  checks.enabled_tools = {
    ok: enabledToolsOk,
    message: enabledToolsOk ? 'enabled_tools matches the expected read-only tool list.' : 'enabled_tools differs from the expected read-only tool list.',
  };
  if (!enabledToolsOk) warnings.push('Configured enabled_tools differ from the expected read-only VibecodeMCP tool list.');

  const configuredCommand = parseTomlString(block, 'command');
  checks.config_command = {
    ok: configuredCommand === 'node',
    message: configuredCommand === 'node' ? 'Configured command is node.' : 'Configured command is not node.',
  };

  const codexExists = options.codexExecutableChecker?.() ?? commandExists('codex');
  checks.codex_executable = {
    ok: codexExists,
    message: codexExists ? 'Codex executable is available.' : 'Codex executable was not found on PATH.',
  };
  if (!codexExists) warnings.push('Codex executable was not found on PATH; config can still be inspected.');

  return {
    ok: checks.configured.ok && checks.tools.ok,
    agent: 'codex',
    scope: config.scope,
    config_path: config.config_path,
    server_name: 'vibecode',
    checks,
    warnings,
    suggestions,
  };
}

function parseTomlString(block: string, key: string): string | null {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(block);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function parseTomlStringArray(block: string, key: string): string[] | null {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(block);
  if (!match) return null;
  const values: string[] = [];
  const stringPattern = /"((?:[^"\\]|\\.)*)"/g;
  let item: RegExpExecArray | null;
  while ((item = stringPattern.exec(match[1])) !== null) {
    try {
      values.push(JSON.parse(`"${item[1]}"`) as string);
    } catch {
      return null;
    }
  }
  return values;
}

function runDefaultToolsProvider(vibecodeBinPath: string): { ok: true; tools: string[] } | { ok: false; error: string } {
  const result = spawnSync('node', [normalizeNativePath(vibecodeBinPath), 'mcp', 'tools', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
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

function commandExists(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = spawnSync(checker, args, { stdio: 'ignore', windowsHide: true, shell: process.platform !== 'win32' });
  return result.status === 0;
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function normalizeNativePath(value: string): string {
  return path.resolve(value);
}

function timestampForBackup(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
