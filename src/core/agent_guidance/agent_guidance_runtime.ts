import crypto from 'crypto';

import {
  readAgentGuidanceConfig,
  type AgentGuidanceMcpToolMetadata,
} from '../config/agent_guidance_config.js';
import { buildAgentGuidanceMcpTools } from '../config/agent_guidance_mcp_tools.js';

export type AgentGuidanceRuntimeSource = 'defaults' | 'file' | 'invalid_file_with_defaults';

export interface AgentGuidanceRuntime {
  enabled: boolean;
  apply_to_terminal_agents: boolean;
  config_path: string;
  source: AgentGuidanceRuntimeSource;
  config_valid: boolean;
  guidance_hash: string;
  general_guidance: string;
  per_tool_notes: Record<string, string>;
  mcp_tool_groups: Record<string, string[]>;
  fallback_guidance: string;
  approval_boundary: string;
  warnings: string[];
  disabled_message?: string;
}

export interface BuildAgentGuidanceRuntimeOptions {
  env?: Record<string, string | undefined>;
  configPath?: string;
  mcpTools?: ReadonlyArray<AgentGuidanceMcpToolMetadata>;
  maxGeneralGuidanceChars?: number;
  maxPerToolNoteChars?: number;
  maxDescriptionNoteChars?: number;
}

const DEFAULT_GENERAL_LIMIT = 6_000;
const DEFAULT_TOOL_NOTE_LIMIT = 800;
export const DEFAULT_DESCRIPTION_NOTE_LIMIT = 240;

export const FALLBACK_GUIDANCE =
  'If MCP tools are unavailable, use equivalent Vibecode CLI commands such as `vibecode codegraph ...` and `vibecode runs ...`.';
export const APPROVAL_BOUNDARY =
  'Vibecode does not manage agent approvals or permissions; the MCP client/agent owns approval, trust, and permission decisions.';
const DISABLED_MESSAGE = 'Agent Guidance is disabled. VibecodeMCP will report status, path, source, and hash only.';

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(0, maxChars - 32);
  return `${value.slice(0, keep).trimEnd()} [truncated ${value.length - keep} chars]`;
}

function groupTools(tools: ReadonlyArray<AgentGuidanceMcpToolMetadata>): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const tool of tools) {
    if (!groups[tool.group]) groups[tool.group] = [];
    groups[tool.group].push(tool.name);
  }
  return groups;
}

function hashRuntimeShape(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildAgentGuidanceRuntime(
  opts: BuildAgentGuidanceRuntimeOptions = {},
): AgentGuidanceRuntime {
  const mcpTools = opts.mcpTools ?? buildAgentGuidanceMcpTools();
  const read = readAgentGuidanceConfig({ env: opts.env, configPath: opts.configPath });
  const source: AgentGuidanceRuntimeSource = read.ok
    ? read.source === 'default'
      ? 'defaults'
      : 'file'
    : 'invalid_file_with_defaults';
  const warnings = [
    ...read.warnings,
    ...(read.error ? [`${read.error.code}: ${read.error.message}`] : []),
  ];
  const knownNames = new Set(mcpTools.map((tool) => tool.name));
  const maxNote = Math.min(
    opts.maxPerToolNoteChars ?? DEFAULT_TOOL_NOTE_LIMIT,
    opts.maxDescriptionNoteChars ?? Number.POSITIVE_INFINITY,
  );
  const perToolNotes: Record<string, string> = {};
  if (read.config.enabled) {
    for (const [name, note] of Object.entries(read.config.per_tool_notes)) {
      if (!knownNames.has(name)) continue;
      if (note.trim() === '') continue;
      perToolNotes[name] = boundText(note.trim(), maxNote);
    }
  }

  const general = read.config.enabled
    ? boundText(read.config.default_guidance.trim(), opts.maxGeneralGuidanceChars ?? DEFAULT_GENERAL_LIMIT)
    : '';

  const hashBase = {
    enabled: read.config.enabled,
    apply_to_terminal_agents: read.config.apply_to_terminal_agents,
    source,
    general_guidance: general,
    per_tool_notes: perToolNotes,
    fallback_guidance: FALLBACK_GUIDANCE,
    approval_boundary: APPROVAL_BOUNDARY,
  };

  return {
    enabled: read.config.enabled,
    apply_to_terminal_agents: read.config.apply_to_terminal_agents,
    config_path: read.configPath,
    source,
    config_valid: read.ok,
    guidance_hash: hashRuntimeShape(hashBase),
    general_guidance: general,
    per_tool_notes: perToolNotes,
    mcp_tool_groups: groupTools(mcpTools),
    fallback_guidance: FALLBACK_GUIDANCE,
    approval_boundary: APPROVAL_BOUNDARY,
    warnings,
    ...(read.config.enabled ? {} : { disabled_message: DISABLED_MESSAGE }),
  };
}

export function buildMcpServerInstructions(runtime: AgentGuidanceRuntime): string {
  if (!runtime.enabled || !runtime.apply_to_terminal_agents) {
    return `Agent Guidance is disabled for terminal agents. Config: ${runtime.config_path}. Hash: ${runtime.guidance_hash.slice(0, 12)}.`;
  }
  return [
    'VibecodeMCP applies user-editable Agent Guidance to its tool descriptions and these server instructions.',
    'At session start, call `vibecode_session_start`, then `vibecode_workspace_snapshot`; read repo rules with `vibecode_project_instructions`.',
    `Guidance hash: ${runtime.guidance_hash.slice(0, 12)}. Config path: ${runtime.config_path}.`,
    'Vibecode does not manage agent approvals or permissions.',
  ].join(' ');
}

export function appendAgentGuidanceToToolDescription(
  canonicalDescription: string,
  toolName: string,
  runtime: Pick<AgentGuidanceRuntime, 'enabled' | 'apply_to_terminal_agents' | 'per_tool_notes'>,
  maxChars = DEFAULT_DESCRIPTION_NOTE_LIMIT,
): string {
  if (!runtime.enabled || !runtime.apply_to_terminal_agents) return canonicalDescription;
  const note = runtime.per_tool_notes[toolName];
  if (!note || note.trim() === '') return canonicalDescription;
  return `${canonicalDescription} User guidance: ${boundText(note.trim(), maxChars)}`;
}

export function buildGuidanceStatusSummary(runtime: AgentGuidanceRuntime): {
  enabled: boolean;
  source: AgentGuidanceRuntimeSource;
  guidance_hash: string;
  config_path: string;
  recommendation: string;
  warnings: string[];
} {
  return {
    enabled: runtime.enabled,
    source: runtime.source,
    guidance_hash: runtime.guidance_hash,
    config_path: runtime.config_path,
    recommendation: 'Agent Guidance is applied to VibecodeMCP tool descriptions and server instructions; edit it via the desktop Settings or the agent-guidance config file.',
    warnings: runtime.warnings,
  };
}
