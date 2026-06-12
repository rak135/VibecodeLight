import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { resolveUserProfileDir } from './user_profile.js';

export const AGENT_GUIDANCE_CONFIG_FILENAME = 'agent-guidance-config.yaml';
export const AGENT_GUIDANCE_SCHEMA_VERSION = 1 as const;

export type AgentGuidanceScope = 'global';
export type AgentGuidanceConfigSource = 'default' | 'file';

export interface AgentGuidanceConfig {
  schema_version: typeof AGENT_GUIDANCE_SCHEMA_VERSION;
  enabled: boolean;
  apply_to_terminal_agents: boolean;
  scope: AgentGuidanceScope;
  default_guidance: string;
  per_tool_notes: Record<string, string>;
  terminal_preflight: AgentGuidanceTerminalPreflightConfig;
}

export type AgentGuidanceTerminalPreflightMode = 'check_only' | 'auto_repair';

export interface AgentGuidanceTerminalPreflightConfig {
  enabled: boolean;
  mode: AgentGuidanceTerminalPreflightMode;
  supported_agents: {
    codex: boolean;
    claude: boolean;
    opencode: boolean;
  };
  repair: {
    create_backup: boolean;
    require_valid_guidance_config: boolean;
  };
}

export interface AgentGuidanceConfigError {
  code: 'AGENT_GUIDANCE_CONFIG_PARSE_ERROR';
  message: string;
}

export interface ReadAgentGuidanceConfigResult {
  ok: boolean;
  config: AgentGuidanceConfig;
  source: AgentGuidanceConfigSource;
  exists: boolean;
  configPath: string;
  warnings: string[];
  error?: AgentGuidanceConfigError;
}

export interface WriteAgentGuidanceConfigResult {
  ok: boolean;
  config: AgentGuidanceConfig;
  configPath: string;
  warnings: string[];
}

const DEFAULT_GUIDANCE_TEXT = [
  'When VibecodeMCP tools are available, use them first.',
  '',
  'Start with:',
  '- vibecode_session_start',
  '- vibecode_workspace_snapshot',
  '',
  'Use Vibecode CodeGraph tools for repository navigation.',
  'Use Vibecode run/artifact tools for Vibecode run history and final prompts.',
  'Use rg/grep for exact literal strings, logs, raw errors, and fallback cases.',
  'Do not call upstream CodeGraph directly.',
  'If MCP tools are unavailable, use equivalent Vibecode CLI commands.',
  'Vibecode does not manage approvals; approval behavior belongs to the MCP client/agent.',
  '',
].join('\n');

const DEFAULT_PER_TOOL_NOTES: Record<string, string> = Object.freeze({
  vibecode_session_start: 'Start or resume your attributed agent session first.',
  vibecode_workspace_snapshot:
    'Use at the start of implementation/review tasks to inspect branch, dirty state, current run, claims, and CodeGraph state.',
  vibecode_codegraph_search:
    'Prefer this over grep/find for code navigation. Use rg/grep for exact literal strings and raw error messages.',
  vibecode_artifact_read: 'Use this before manually browsing .vibecode/runs files.',
});

/** Return a fresh, defensive copy of the default agent guidance config. */
export function defaultAgentGuidanceConfig(): AgentGuidanceConfig {
  return {
    schema_version: AGENT_GUIDANCE_SCHEMA_VERSION,
    enabled: true,
    apply_to_terminal_agents: true,
    scope: 'global',
    default_guidance: DEFAULT_GUIDANCE_TEXT,
    per_tool_notes: { ...DEFAULT_PER_TOOL_NOTES },
    terminal_preflight: defaultAgentGuidanceTerminalPreflightConfig(),
  };
}

export function defaultAgentGuidanceTerminalPreflightConfig(): AgentGuidanceTerminalPreflightConfig {
  return {
    enabled: true,
    mode: 'check_only',
    supported_agents: {
      codex: true,
      claude: true,
      opencode: true,
    },
    repair: {
      create_backup: true,
      require_valid_guidance_config: true,
    },
  };
}

/** Resolve the dedicated agent guidance config path under %LOCALAPPDATA%/vibecodelight/. */
export function getAgentGuidanceConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveUserProfileDir(env), AGENT_GUIDANCE_CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function parsePerToolNotes(value: unknown, warnings: string[]): Record<string, string> {
  if (value === undefined || value === null) return { ...DEFAULT_PER_TOOL_NOTES };
  if (!isRecord(value)) {
    warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: per_tool_notes must be a mapping; using defaults.');
    return { ...DEFAULT_PER_TOOL_NOTES };
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const s = coerceString(raw);
    if (s === null) {
      warnings.push(
        `AGENT_GUIDANCE_CONFIG_WARNING: per_tool_notes.${key} must be a string; ignored.`,
      );
      continue;
    }
    out[key] = s;
  }
  return out;
}

function parseTerminalPreflight(
  value: unknown,
  warnings: string[],
): AgentGuidanceTerminalPreflightConfig {
  const defaults = defaultAgentGuidanceTerminalPreflightConfig();
  if (value === undefined || value === null) return defaults;
  if (!isRecord(value)) {
    warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight must be a mapping; using defaults.');
    return defaults;
  }

  const enabled = coerceBoolean(value.enabled);
  if (value.enabled !== undefined && enabled === null) {
    warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.enabled must be boolean; using default.');
  }

  const modeRaw = coerceString(value.mode);
  let mode = defaults.mode;
  if (modeRaw === 'check_only' || modeRaw === 'auto_repair') {
    mode = modeRaw;
  } else if (value.mode !== undefined) {
    warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.mode must be check_only or auto_repair; using default.');
  }

  const supportedRaw = value.supported_agents;
  const supported = { ...defaults.supported_agents };
  if (supportedRaw !== undefined) {
    if (isRecord(supportedRaw)) {
      const codex = coerceBoolean(supportedRaw.codex);
      const claude = coerceBoolean(supportedRaw.claude);
      const opencode = coerceBoolean(supportedRaw.opencode);
      if (supportedRaw.codex !== undefined && codex === null) {
        warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.supported_agents.codex must be boolean; using default.');
      }
      if (supportedRaw.claude !== undefined && claude === null) {
        warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.supported_agents.claude must be boolean; using default.');
      }
      if (supportedRaw.opencode !== undefined && opencode === null) {
        warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.supported_agents.opencode must be boolean; using default.');
      }
      supported.codex = codex ?? supported.codex;
      supported.claude = claude ?? supported.claude;
      supported.opencode = opencode ?? supported.opencode;
    } else {
      warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.supported_agents must be a mapping; using defaults.');
    }
  }

  const repairRaw = value.repair;
  const repair = { ...defaults.repair };
  if (repairRaw !== undefined) {
    if (isRecord(repairRaw)) {
      const createBackup = coerceBoolean(repairRaw.create_backup);
      const requireValid = coerceBoolean(repairRaw.require_valid_guidance_config);
      if (repairRaw.create_backup !== undefined && createBackup === null) {
        warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.repair.create_backup must be boolean; using default.');
      }
      if (repairRaw.require_valid_guidance_config !== undefined && requireValid === null) {
        warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.repair.require_valid_guidance_config must be boolean; using default.');
      }
      repair.create_backup = createBackup ?? repair.create_backup;
      repair.require_valid_guidance_config = requireValid ?? repair.require_valid_guidance_config;
    } else {
      warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: terminal_preflight.repair must be a mapping; using defaults.');
    }
  }

  return {
    enabled: enabled ?? defaults.enabled,
    mode,
    supported_agents: supported,
    repair,
  };
}

function applyParsedConfig(
  parsed: unknown,
  warnings: string[],
): AgentGuidanceConfig {
  const defaults = defaultAgentGuidanceConfig();
  if (!isRecord(parsed)) {
    warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: top-level YAML must be a mapping; using defaults.');
    return defaults;
  }

  const schemaVersion = parsed.schema_version;
  if (schemaVersion !== AGENT_GUIDANCE_SCHEMA_VERSION) {
    if (schemaVersion !== undefined) {
      warnings.push(
        `AGENT_GUIDANCE_CONFIG_WARNING: unsupported schema_version ${JSON.stringify(schemaVersion)}; expected ${AGENT_GUIDANCE_SCHEMA_VERSION}.`,
      );
    }
  }

  const enabled = coerceBoolean(parsed.enabled);
  const applyToTerminal = coerceBoolean(parsed.apply_to_terminal_agents);
  const scopeStr = coerceString(parsed.scope);
  const guidance = coerceString(parsed.default_guidance);

  if (parsed.enabled !== undefined && enabled === null) {
    warnings.push('AGENT_GUIDANCE_CONFIG_WARNING: enabled must be boolean; using default.');
  }
  if (parsed.apply_to_terminal_agents !== undefined && applyToTerminal === null) {
    warnings.push(
      'AGENT_GUIDANCE_CONFIG_WARNING: apply_to_terminal_agents must be boolean; using default.',
    );
  }

  return {
    schema_version: AGENT_GUIDANCE_SCHEMA_VERSION,
    enabled: enabled ?? defaults.enabled,
    apply_to_terminal_agents: applyToTerminal ?? defaults.apply_to_terminal_agents,
    scope: scopeStr === 'global' ? 'global' : defaults.scope,
    default_guidance: guidance ?? defaults.default_guidance,
    per_tool_notes: parsePerToolNotes(parsed.per_tool_notes, warnings),
    terminal_preflight: parseTerminalPreflight(parsed.terminal_preflight, warnings),
  };
}

export function readAgentGuidanceConfig(opts: {
  env?: Record<string, string | undefined>;
  configPath?: string;
} = {}): ReadAgentGuidanceConfigResult {
  const configPath = opts.configPath ?? getAgentGuidanceConfigPath(opts.env ?? process.env);
  if (!fs.existsSync(configPath)) {
    return {
      ok: true,
      config: defaultAgentGuidanceConfig(),
      source: 'default',
      exists: false,
      configPath,
      warnings: [],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      config: defaultAgentGuidanceConfig(),
      source: 'default',
      exists: true,
      configPath,
      warnings: [],
      error: {
        code: 'AGENT_GUIDANCE_CONFIG_PARSE_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    return {
      ok: false,
      config: defaultAgentGuidanceConfig(),
      source: 'default',
      exists: true,
      configPath,
      warnings: [],
      error: {
        code: 'AGENT_GUIDANCE_CONFIG_PARSE_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const warnings: string[] = [];
  const config = applyParsedConfig(parsed, warnings);
  return {
    ok: true,
    config,
    source: 'file',
    exists: true,
    configPath,
    warnings,
  };
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function normalizeForWrite(config: AgentGuidanceConfig): AgentGuidanceConfig {
  const defaults = defaultAgentGuidanceConfig();
  return {
    schema_version: AGENT_GUIDANCE_SCHEMA_VERSION,
    enabled: typeof config.enabled === 'boolean' ? config.enabled : defaults.enabled,
    apply_to_terminal_agents:
      typeof config.apply_to_terminal_agents === 'boolean'
        ? config.apply_to_terminal_agents
        : defaults.apply_to_terminal_agents,
    scope: config.scope === 'global' ? 'global' : defaults.scope,
    default_guidance:
      typeof config.default_guidance === 'string' ? config.default_guidance : defaults.default_guidance,
    per_tool_notes: isRecord(config.per_tool_notes)
      ? Object.fromEntries(
          Object.entries(config.per_tool_notes).filter(([, v]) => typeof v === 'string') as Array<
            [string, string]
          >,
        )
      : { ...defaults.per_tool_notes },
    terminal_preflight: normalizeTerminalPreflightForWrite(config.terminal_preflight),
  };
}

export function normalizeTerminalPreflightForWrite(
  config: Partial<AgentGuidanceTerminalPreflightConfig> | unknown,
): AgentGuidanceTerminalPreflightConfig {
  const defaults = defaultAgentGuidanceTerminalPreflightConfig();
  if (!isRecord(config)) return defaults;
  const supportedRaw = config.supported_agents;
  const repairRaw = config.repair;
  return {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : defaults.enabled,
    mode: config.mode === 'auto_repair' || config.mode === 'check_only' ? config.mode : defaults.mode,
    supported_agents: {
      codex: isRecord(supportedRaw) && typeof supportedRaw.codex === 'boolean'
        ? supportedRaw.codex
        : defaults.supported_agents.codex,
      claude: isRecord(supportedRaw) && typeof supportedRaw.claude === 'boolean'
        ? supportedRaw.claude
        : defaults.supported_agents.claude,
      opencode: isRecord(supportedRaw) && typeof supportedRaw.opencode === 'boolean'
        ? supportedRaw.opencode
        : defaults.supported_agents.opencode,
    },
    repair: {
      create_backup: isRecord(repairRaw) && typeof repairRaw.create_backup === 'boolean'
        ? repairRaw.create_backup
        : defaults.repair.create_backup,
      require_valid_guidance_config:
        isRecord(repairRaw) && typeof repairRaw.require_valid_guidance_config === 'boolean'
          ? repairRaw.require_valid_guidance_config
          : defaults.repair.require_valid_guidance_config,
    },
  };
}

export function writeAgentGuidanceConfig(opts: {
  env?: Record<string, string | undefined>;
  configPath?: string;
  config: AgentGuidanceConfig;
}): WriteAgentGuidanceConfigResult {
  const configPath = opts.configPath ?? getAgentGuidanceConfigPath(opts.env ?? process.env);
  const normalized = normalizeForWrite(opts.config);
  const serialized = YAML.stringify(normalized);
  writeAtomic(configPath, serialized);
  return {
    ok: true,
    config: normalized,
    configPath,
    warnings: [],
  };
}

export function resetAgentGuidanceConfig(opts: {
  env?: Record<string, string | undefined>;
  configPath?: string;
} = {}): WriteAgentGuidanceConfigResult {
  const config = defaultAgentGuidanceConfig();
  return writeAgentGuidanceConfig({ ...opts, config });
}

export interface AgentGuidanceMcpToolMetadata {
  name: string;
  group: 'workspace_orientation' | 'codegraph' | 'runs_artifacts' | 'coordination';
  description: string;
}

export interface EffectiveAgentGuidanceToolNote {
  name: string;
  group: AgentGuidanceMcpToolMetadata['group'];
  note: string;
}

export interface EffectiveAgentGuidance {
  enabled: boolean;
  text: string;
  toolNotes: EffectiveAgentGuidanceToolNote[];
}

const APPROVAL_BOUNDARY_LINE =
  'Vibecode does not manage agent approvals; approval/permission belongs to the MCP client/agent.';
const FALLBACK_LINE = 'If MCP tools are unavailable, use equivalent Vibecode CLI commands.';

export function buildEffectiveAgentGuidance(opts: {
  config: AgentGuidanceConfig;
  mcpTools: ReadonlyArray<AgentGuidanceMcpToolMetadata>;
}): EffectiveAgentGuidance {
  const { config, mcpTools } = opts;
  if (!config.enabled) {
    return {
      enabled: false,
      text: 'Agent guidance is disabled. No guidance will be presented to terminal agents from this layer.',
      toolNotes: [],
    };
  }
  const knownToolNames = new Set(mcpTools.map((t) => t.name));
  const toolNotes: EffectiveAgentGuidanceToolNote[] = [];
  for (const tool of mcpTools) {
    const note = config.per_tool_notes[tool.name];
    if (typeof note === 'string' && note.trim() !== '') {
      toolNotes.push({ name: tool.name, group: tool.group, note });
    }
  }
  // Drop notes for unknown tools — they would surprise the user in the preview.
  for (const name of Object.keys(config.per_tool_notes)) {
    if (!knownToolNames.has(name)) {
      // intentionally ignored
    }
  }

  const lines: string[] = [];
  lines.push('# Effective agent guidance (preview)');
  lines.push('');
  lines.push('Status: enabled');
  lines.push(`Scope: ${config.scope}`);
  lines.push(`Apply to terminal agents: ${config.apply_to_terminal_agents ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Default guidance');
  lines.push('');
  lines.push(config.default_guidance.trim());
  lines.push('');
  if (toolNotes.length > 0) {
    lines.push('## Per-tool notes');
    lines.push('');
    for (const note of toolNotes) {
      lines.push(`- ${note.name} (${note.group}): ${note.note}`);
    }
    lines.push('');
  }
  lines.push('## Fallback');
  lines.push('');
  lines.push(FALLBACK_LINE);
  lines.push('');
  lines.push('## Approval boundary');
  lines.push('');
  lines.push(APPROVAL_BOUNDARY_LINE);
  lines.push('');
  lines.push('---');
  lines.push('This guidance is stored locally and previewed only. It has NOT been installed into any agent configuration.');
  return {
    enabled: true,
    text: lines.join('\n'),
    toolNotes,
  };
}
