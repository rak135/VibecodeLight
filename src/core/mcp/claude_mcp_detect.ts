import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLAUDE_MCP_SERVER_NAME,
  buildClaudeMcpInstallCommand,
  normalizeMcpPath,
  resolveDefaultVibecodeBinPath,
} from './claude_config.js';

/**
 * Read-only detection of Claude Code MCP configuration for the `vibecode` server.
 *
 * Claude Code can load an MCP server from more than one safe config source:
 *  - local scope:   ~/.claude.json -> projects["<repo>"].mcpServers.vibecode
 *  - project scope: <repo>/.mcp.json -> mcpServers.vibecode
 *  - user scope:    ~/.claude.json -> mcpServers.vibecode (global)
 *
 * `claude mcp add-json ... --scope local` (used by the safe installer) writes the
 * local-scope form, which the previous status detector never inspected. This module
 * reads all three sources without mutating anything and reports which one is effective.
 *
 * Safety: only the `vibecode` server's command/args/repo binding and the source file
 * path are surfaced. No other server names and no unrelated config fields are read out.
 */

export type ClaudeMcpDetectedScope = 'local' | 'project' | 'user';

export interface ClaudeMcpDetectedSource {
  scope: ClaudeMcpDetectedScope;
  config_path: string;
  command?: string;
  args?: string[];
  repo_binding?: string;
  matches_repo: boolean;
  command_ok: boolean;
  up_to_date: boolean;
}

export type ClaudeMcpDetectionStatus = 'up_to_date' | 'stale' | 'unknown';

export interface ClaudeMcpDetectionResult {
  configured: boolean;
  status: ClaudeMcpDetectionStatus;
  effective?: ClaudeMcpDetectedSource;
  sources: ClaudeMcpDetectedSource[];
  warnings: string[];
}

export interface ClaudeMcpDetectOptions {
  repoRoot: string;
  vibecodeBinPath?: string;
  env?: Record<string, string | undefined>;
  /** Directory that holds `.claude.json`; defaults to CLAUDE_CONFIG_DIR or the user home. */
  claudeConfigDir?: string;
}

// Highest precedence first: a local-scope server overrides project, which overrides user.
const SCOPE_PRECEDENCE: ClaudeMcpDetectedScope[] = ['local', 'project', 'user'];

interface RawServer {
  command?: unknown;
  args?: unknown;
}

export function resolveClaudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  return path.resolve(home);
}

export function detectClaudeMcpConfig(options: ClaudeMcpDetectOptions): ClaudeMcpDetectionResult {
  const env = options.env ?? process.env;
  const repoRoot = normalizeMcpPath(options.repoRoot);
  const binPath = normalizeMcpPath(options.vibecodeBinPath ?? resolveDefaultVibecodeBinPath());
  const expected = buildClaudeMcpInstallCommand({ repoRoot: options.repoRoot, vibecodeBinPath: binPath });
  const expectedArgs = expected.server_config.args;
  const warnings: string[] = [];
  const configDir = options.claudeConfigDir ? path.resolve(options.claudeConfigDir) : resolveClaudeConfigDir(env);
  const claudeJsonPath = path.join(configDir, '.claude.json');
  const mcpJsonPath = path.join(repoRoot, '.mcp.json');

  const sources: ClaudeMcpDetectedSource[] = [];
  const claudeJson = readJsonObject(claudeJsonPath, 'CLAUDE_MCP_CONFIG_PARSE_WARNING', warnings);
  const mcpJson = readJsonObject(mcpJsonPath, 'CLAUDE_MCP_PROJECT_CONFIG_PARSE_WARNING', warnings);

  // local scope: ~/.claude.json -> projects["<repo>"].mcpServers.vibecode
  const localServer = findProjectServer(claudeJson, repoRoot);
  if (localServer) {
    sources.push(buildSource('local', claudeJsonPath, localServer, repoRoot, binPath, expectedArgs));
  }

  // project scope: <repo>/.mcp.json -> mcpServers.vibecode
  const projectServer = findServerInMap(mcpJson, 'mcpServers');
  if (projectServer) {
    sources.push(buildSource('project', mcpJsonPath, projectServer, repoRoot, binPath, expectedArgs));
  }

  // user scope: ~/.claude.json -> mcpServers.vibecode
  const userServer = findServerInMap(claudeJson, 'mcpServers');
  if (userServer) {
    sources.push(buildSource('user', claudeJsonPath, userServer, repoRoot, binPath, expectedArgs));
  }

  if (sources.length === 0) {
    return { configured: false, status: 'unknown', sources, warnings };
  }

  const effective = pickEffective(sources);
  return {
    configured: true,
    status: effective.up_to_date ? 'up_to_date' : 'stale',
    effective,
    sources,
    warnings,
  };
}

function pickEffective(sources: ClaudeMcpDetectedSource[]): ClaudeMcpDetectedSource {
  for (const scope of SCOPE_PRECEDENCE) {
    const match = sources.find((s) => s.scope === scope);
    if (match) return match;
  }
  return sources[0];
}

function buildSource(
  scope: ClaudeMcpDetectedScope,
  configPath: string,
  server: RawServer,
  repoRoot: string,
  binPath: string,
  expectedArgs: readonly string[],
): ClaudeMcpDetectedSource {
  const command = typeof server.command === 'string' ? server.command : undefined;
  const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === 'string') : undefined;
  const repoBindingRaw = args ? extractRepoBinding(args) : undefined;
  const repoBinding = repoBindingRaw ? repoBindingRaw.replace(/\\/g, '/') : undefined;
  const matchesRepo = repoBinding !== undefined && pathsEqual(repoBinding, repoRoot);
  const commandOk = command === 'node' && args !== undefined && args.length > 0 && pathsEqual(args[0], binPath);
  const upToDate = command === 'node' && args !== undefined && argsMatch(args, expectedArgs);
  return {
    scope,
    config_path: configPath,
    command,
    args,
    repo_binding: repoBinding,
    matches_repo: matchesRepo,
    command_ok: commandOk,
    up_to_date: upToDate,
  };
}

function extractRepoBinding(args: string[]): string | undefined {
  const idx = args.indexOf('--repo');
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function argsMatch(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((value, index) => argEqual(actual[index], value));
}

function argEqual(a: string, b: string): boolean {
  const na = a.replace(/\\/g, '/');
  const nb = b.replace(/\\/g, '/');
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function pathsEqual(a: string, b: string): boolean {
  return argEqual(a, b);
}

function findProjectServer(root: Record<string, unknown> | null, repoRoot: string): RawServer | null {
  if (!root) return null;
  const projects = root.projects;
  if (!projects || typeof projects !== 'object') return null;
  for (const [key, value] of Object.entries(projects as Record<string, unknown>)) {
    if (!pathsEqual(key, repoRoot)) continue;
    const server = findServerInMap(value as Record<string, unknown> | null, 'mcpServers');
    if (server) return server;
  }
  return null;
}

function findServerInMap(container: Record<string, unknown> | null, mapKey: string): RawServer | null {
  if (!container || typeof container !== 'object') return null;
  const map = (container as Record<string, unknown>)[mapKey];
  if (!map || typeof map !== 'object') return null;
  const server = (map as Record<string, unknown>)[CLAUDE_MCP_SERVER_NAME];
  if (!server || typeof server !== 'object') return null;
  return server as RawServer;
}

function readJsonObject(
  filePath: string,
  warningCode: string,
  warnings: string[],
): Record<string, unknown> | null {
  let text: string;
  try {
    if (!fs.existsSync(filePath)) return null;
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    warnings.push(`${warningCode}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch (error) {
    warnings.push(`${warningCode}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
