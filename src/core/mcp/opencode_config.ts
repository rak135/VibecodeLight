import fs from 'fs';
import os from 'os';
import path from 'path';

import { VIBECODE_MCP_TOOL_NAMES } from '../../app/mcp/tool_registry.js';

export type OpenCodeAgent = 'opencode';
export type OpenCodeConfigScope = 'user' | 'project';

export const OPENCODE_MCP_SERVER_NAME = 'vibecode';

export const OPENCODE_MCP_ENABLED_TOOLS: readonly string[] = Object.freeze([...VIBECODE_MCP_TOOL_NAMES]);

export interface OpenCodeMcpConfigOptions {
  repoRoot: string;
  scope?: OpenCodeConfigScope;
  configPath?: string;
  opencodeConfigDir?: string;
  vibecodeBinPath?: string;
}

export interface OpenCodeMcpConfigEnvelope {
  ok: true;
  agent: 'opencode';
  scope: OpenCodeConfigScope;
  config_path: string;
  server_name: 'vibecode';
  command: string[];
  enabled_tools: readonly string[];
  warnings: string[];
}

export interface OpenCodeConfigPathResult {
  scope: OpenCodeConfigScope;
  configPath: string;
  warnings: string[];
}

export type OpenCodeConfigErrorCode =
  | 'OPENCODE_CONFIG_NOT_FOUND'
  | 'OPENCODE_CONFIG_INVALID'
  | 'OPENCODE_CONFIG_WRITE_FAILED'
  | 'OPENCODE_CONFIG_JSONC_UNSUPPORTED'
  | 'OPENCODE_CONFIG_PARSE_FAILED'
  | 'VIBECODE_MCP_NOT_AVAILABLE'
  | 'INVALID_AGENT'
  | 'INVALID_SCOPE'
  | 'REPO_NOT_FOUND'
  | 'REPO_NOT_A_DIRECTORY';

export interface OpenCodeConfigError {
  code: OpenCodeConfigErrorCode;
  message: string;
  path?: string;
  details?: string[];
}

export interface OpenCodeInstallOptions extends OpenCodeMcpConfigOptions {
  dryRun?: boolean;
  yes?: boolean;
  platform?: typeof process.platform;
}

export type OpenCodeInstallResult =
  | {
      ok: true;
      agent: 'opencode';
      scope: OpenCodeConfigScope;
      config_path: string;
      server_name: 'vibecode';
      action: 'create' | 'update';
      existing_server: boolean;
      dry_run: boolean;
      backup_path: string | null;
      planned_json: string;
      warnings: string[];
      restart_required: true;
    }
  | {
      ok: false;
      error: OpenCodeConfigError;
      warnings: string[];
    };

export interface OpenCodeMcpDetectedEntry {
  server_name: string;
  command: string[];
  type: string;
  enabled: boolean;
  config_path: string;
  scope: OpenCodeConfigScope;
}

export interface OpenCodeMcpDetectionResult {
  configured: boolean;
  status: 'up_to_date' | 'stale' | 'not_configured' | 'unknown';
  effective?: OpenCodeMcpDetectedEntry;
  warnings: string[];
}

export function normalizeOpenCodePath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/');
}

export function parseOpenCodeScope(value: string | undefined): OpenCodeConfigScope | null {
  if (value === undefined || value.trim() === '') return 'project';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'user' || normalized === 'project') return normalized;
  return null;
}

export function resolveOpenCodeConfigPath(options: OpenCodeMcpConfigOptions): OpenCodeConfigPathResult {
  const scope = options.scope ?? 'project';
  if (options.configPath) {
    return { scope, configPath: path.resolve(options.configPath), warnings: [] };
  }

  if (scope === 'project') {
    return {
      scope,
      configPath: path.join(path.resolve(options.repoRoot), 'opencode.json'),
      warnings: [
        'OpenCode merges project config with global config; project keys override conflicting global keys.',
      ],
    };
  }

  const configDir = options.opencodeConfigDir
    ?? path.join(os.homedir(), '.config', 'opencode');
  return {
    scope,
    configPath: path.join(path.resolve(configDir), 'opencode.json'),
    warnings: [],
  };
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

export function buildOpenCodeMcpConfig(options: OpenCodeMcpConfigOptions): OpenCodeMcpConfigEnvelope {
  const repoRoot = normalizeOpenCodePath(options.repoRoot);
  const scope = options.scope ?? 'project';
  const pathInfo = resolveOpenCodeConfigPath({ ...options, scope });
  const vibecodeBinPath = normalizeOpenCodePath(options.vibecodeBinPath ?? resolveDefaultVibecodeBinPath());
  const command = [
    'node',
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

  return {
    ok: true,
    agent: 'opencode',
    scope,
    config_path: normalizeOpenCodePath(pathInfo.configPath),
    server_name: OPENCODE_MCP_SERVER_NAME,
    command,
    enabled_tools: OPENCODE_MCP_ENABLED_TOOLS,
    warnings: pathInfo.warnings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function looksLikeJsonc(content: string): boolean {
  const stripped = content.replace(/"(?:[^"\\]|\\.)*"/g, '');
  return /\/\/|\/\*/.test(stripped);
}

function readOpenCodeConfig(
  configPath: string,
  warnings: string[],
): { ok: true; data: Record<string, unknown>; raw: string } | { ok: false; error: OpenCodeConfigError } {
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      error: {
        code: 'OPENCODE_CONFIG_NOT_FOUND',
        message: 'OpenCode config file was not found.',
        path: configPath,
      },
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'OPENCODE_CONFIG_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
        path: configPath,
      },
    };
  }

  if (looksLikeJsonc(raw)) {
    return {
      ok: false,
      error: {
        code: 'OPENCODE_CONFIG_JSONC_UNSUPPORTED',
        message: 'OpenCode config file uses JSONC (comments); Vibecode cannot safely patch JSONC without destroying comments. Convert to plain JSON or manually add the MCP server entry.',
        path: configPath,
        details: [
          'Detected // or /* */ comments in the config file.',
          'Vibecode writes plain JSON only to preserve config integrity.',
          'Remove comments from opencode.json or rename to opencode.jsonc and add the MCP entry manually.',
        ],
      },
    };
  }

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        ok: false,
        error: {
          code: 'OPENCODE_CONFIG_INVALID',
          message: 'OpenCode config is not a JSON object.',
          path: configPath,
        },
      };
    }
    data = parsed;
  } catch (err) {
    warnings.push(`OPENCODE_CONFIG_PARSE_WARNING: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      error: {
        code: 'OPENCODE_CONFIG_PARSE_FAILED',
        message: `Failed to parse OpenCode config: ${err instanceof Error ? err.message : String(err)}`,
        path: configPath,
      },
    };
  }

  return { ok: true, data, raw };
}

export function detectOpenCodeMcpConfig(options: OpenCodeMcpConfigOptions & { vibecodeBinPath?: string }): OpenCodeMcpDetectionResult {
  const warnings: string[] = [];
  const pathInfo = resolveOpenCodeConfigPath(options);
  const configPath = normalizeNativePath(pathInfo.configPath);

  const read = readOpenCodeConfig(configPath, warnings);
  if (!read.ok) {
    if (read.error.code === 'OPENCODE_CONFIG_NOT_FOUND') {
      return { configured: false, status: 'not_configured', warnings };
    }
    warnings.push(`${read.error.code}: ${read.error.message}`);
    return { configured: false, status: 'unknown', warnings };
  }

  const mcp = read.data.mcp;
  if (!isRecord(mcp)) {
    return { configured: false, status: 'not_configured', warnings };
  }

  const vibecode = mcp.vibecode;
  if (!isRecord(vibecode)) {
    return { configured: false, status: 'not_configured', warnings };
  }

  const command = vibecode.command;
  const type = vibecode.type;
  const enabled = vibecode.enabled;

  if (!Array.isArray(command) || command.length === 0) {
    return {
      configured: true,
      status: 'stale',
      warnings: [...warnings, 'OPENCODE_MCP_VIBECODE_ENTRY_MISSING_COMMAND: mcp.vibecode.command is not a valid array.'],
    };
  }

  const commandStrings = command.map((c) => String(c));
  const expectedConfig = buildOpenCodeMcpConfig(options);
  const commandMatch = arraysEqual(commandStrings, expectedConfig.command);
  const typeOk = type === 'local';
  const enabledOk = enabled === true;

  if (commandMatch && !typeOk) {
    warnings.push(
      `OPENCODE_MCP_TYPE_MISMATCH: mcp.vibecode.type is "${String(type ?? '')}" but expected "local".`,
    );
  }
  if (commandMatch && !enabledOk) {
    warnings.push(
      'OPENCODE_MCP_DISABLED: mcp.vibecode.enabled is not true.',
    );
  }

  const effective: OpenCodeMcpDetectedEntry = {
    server_name: OPENCODE_MCP_SERVER_NAME,
    command: commandStrings,
    type: String(type ?? ''),
    enabled: enabled === true,
    config_path: configPath,
    scope: pathInfo.scope,
  };

  return {
    configured: true,
    status: commandMatch && typeOk && enabledOk ? 'up_to_date' : 'stale',
    effective,
    warnings,
  };
}

function buildServerEntry(options: OpenCodeMcpConfigOptions): Record<string, unknown> {
  const config = buildOpenCodeMcpConfig(options);
  return {
    type: 'local',
    command: config.command,
    enabled: true,
  };
}

function patchOpenCodeConfig(
  existing: Record<string, unknown> | null,
  serverEntry: Record<string, unknown>,
): { data: Record<string, unknown>; existed: boolean } {
  const data = existing !== null ? { ...existing } : {};
  const mcp = isRecord(data.mcp) ? { ...data.mcp } : {};
  const existed = isRecord(mcp.vibecode);
  mcp.vibecode = serverEntry;
  data.mcp = mcp;
  return { data, existed };
}

function validateOpenCodeConfig(data: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  if (!isRecord(data.mcp)) {
    return { ok: false, error: 'patched config is missing the mcp key' };
  }
  if (!isRecord(data.mcp.vibecode)) {
    return { ok: false, error: 'patched config is missing mcp.vibecode' };
  }
  const vibecode = data.mcp.vibecode;
  if (!Array.isArray(vibecode.command) || vibecode.command.length === 0) {
    return { ok: false, error: 'patched mcp.vibecode.command is not a valid array' };
  }
  if (vibecode.type !== 'local') {
    return { ok: false, error: 'patched mcp.vibecode.type is not "local"' };
  }
  if (vibecode.enabled !== true) {
    return { ok: false, error: 'patched mcp.vibecode.enabled is not true' };
  }
  return { ok: true };
}

function timestampForBackup(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function normalizeNativePath(value: string): string {
  return path.resolve(value);
}

export function applyOpenCodeMcpInstall(options: OpenCodeInstallOptions): OpenCodeInstallResult {
  const config = buildOpenCodeMcpConfig(options);
  const configPath = normalizeNativePath(config.config_path);
  const exists = fs.existsSync(configPath);
  const warnings = [...config.warnings];

  if (exists) {
    const read = readOpenCodeConfig(configPath, warnings);
    if (!read.ok) {
      if (read.error.code === 'OPENCODE_CONFIG_JSONC_UNSUPPORTED') {
        return { ok: false, error: read.error, warnings };
      }
      if (read.error.code === 'OPENCODE_CONFIG_PARSE_FAILED') {
        return { ok: false, error: read.error, warnings };
      }
      // For other errors (e.g., not found), treat as create
    }
  }

  let existingData: Record<string, unknown> | null = null;
  if (exists) {
    const read = readOpenCodeConfig(configPath, warnings);
    if (!read.ok) {
      if (read.error.code === 'OPENCODE_CONFIG_JSONC_UNSUPPORTED') {
        return { ok: false, error: read.error, warnings };
      }
      return { ok: false, error: read.error, warnings };
    }
    existingData = read.data;
  }

  const serverEntry = buildServerEntry(options);
  const patched = patchOpenCodeConfig(existingData, serverEntry);
  const action = patched.existed ? 'update' : 'create';

  if (!options.dryRun && !options.yes) {
    return {
      ok: false,
      error: {
        code: 'OPENCODE_CONFIG_WRITE_FAILED',
        message: 'Refusing to write OpenCode config without --yes. Use --dry-run to preview or --yes to install.',
        path: config.config_path,
        details: ['No files were written.'],
      },
      warnings,
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      agent: 'opencode',
      scope: config.scope,
      config_path: config.config_path,
      server_name: 'vibecode',
      action,
      existing_server: patched.existed,
      dry_run: true,
      backup_path: null,
      planned_json: JSON.stringify(patched.data, null, 2),
      warnings,
      restart_required: true,
    };
  }

  const validation = validateOpenCodeConfig(patched.data);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: 'OPENCODE_CONFIG_INVALID',
        message: `Refusing to write OpenCode config: validation failed (${validation.error}).`,
        path: config.config_path,
        details: ['No files were written.', 'The existing OpenCode config was left unchanged.'],
      },
      warnings,
    };
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let backupPath: string | null = null;
    if (exists) {
      backupPath = `${configPath}.bak.${timestampForBackup()}`;
      fs.copyFileSync(configPath, backupPath);
    }
    const jsonOutput = JSON.stringify(patched.data, null, 2);
    const tempPath = `${configPath}.tmp.${process.pid}`;
    fs.writeFileSync(tempPath, jsonOutput, 'utf8');
    fs.renameSync(tempPath, configPath);
    return {
      ok: true,
      agent: 'opencode',
      scope: config.scope,
      config_path: config.config_path,
      server_name: 'vibecode',
      action,
      existing_server: patched.existed,
      dry_run: false,
      backup_path: backupPath ? normalizeOpenCodePath(backupPath) : null,
      planned_json: jsonOutput,
      warnings,
      restart_required: true,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'OPENCODE_CONFIG_WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        path: config.config_path,
        details: ['Failed while writing OpenCode config.'],
      },
      warnings,
    };
  }
}
