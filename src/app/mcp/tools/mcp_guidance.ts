import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  MCP_GUIDANCE_INPUT_SCHEMA,
  rejectUnknownKeys,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import {
  buildAgentGuidanceRuntime,
  type AgentGuidanceRuntime,
} from '../../../core/agent_guidance/agent_guidance_runtime.js';

const TOOL_NAME = 'vibecode_mcp_guidance';
const ALLOWED_KEYS = new Set<string>();

export interface McpGuidanceToolDeps {
  env?: Record<string, string | undefined>;
  runtime?: AgentGuidanceRuntime;
}

function renderText(runtime: AgentGuidanceRuntime): string {
  const lines: string[] = ['# VibecodeMCP Agent Guidance', ''];
  lines.push(`enabled: ${runtime.enabled ? 'yes' : 'no'}`);
  lines.push(`apply_to_terminal_agents: ${runtime.apply_to_terminal_agents ? 'yes' : 'no'}`);
  lines.push(`source: ${runtime.source}`);
  lines.push(`config_path: ${runtime.config_path}`);
  lines.push(`guidance_hash: ${runtime.guidance_hash}`);
  if (runtime.warnings.length > 0) {
    lines.push('');
    lines.push('warnings:');
    for (const warning of runtime.warnings) lines.push(`  - ${warning}`);
  }
  if (!runtime.enabled) {
    lines.push('');
    lines.push(runtime.disabled_message ?? 'Agent Guidance is disabled.');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('## General Guidance');
  lines.push('');
  lines.push(runtime.general_guidance);
  const noteEntries = Object.entries(runtime.per_tool_notes);
  if (noteEntries.length > 0) {
    lines.push('');
    lines.push('## Per-tool Notes');
    for (const [name, note] of noteEntries) lines.push(`- ${name}: ${note}`);
  }
  lines.push('');
  lines.push('## MCP Tool Groups');
  for (const [group, names] of Object.entries(runtime.mcp_tool_groups)) {
    lines.push(`- ${group}: ${names.join(', ')}`);
  }
  lines.push('');
  lines.push('## Fallback');
  lines.push(runtime.fallback_guidance);
  lines.push('');
  lines.push('## Approval Boundary');
  lines.push(runtime.approval_boundary);
  return lines.join('\n').trimEnd();
}

export function buildMcpGuidanceTool(deps: McpGuidanceToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = MCP_GUIDANCE_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'VibecodeMCP usage guide',
    description:
      'Call this at session start. Returns the effective user-editable Agent Guidance exposed through VibecodeMCP, including per-tool notes, fallback rules, and approval boundaries. Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', unknown.message),
        });
      }

      const runtime = deps.runtime ?? input.context.agentGuidance ?? buildAgentGuidanceRuntime({ env: deps.env });
      const data = {
        ...runtime,
        sections: runtime.enabled
          ? [
              'General Guidance',
              'Per-tool Notes',
              'MCP Tool Groups',
              'Fallback',
              'Approval Boundary',
            ]
          : ['Disabled'],
        warnings: runtime.warnings,
      };

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(runtime),
        data,
        warnings: runtime.warnings,
        durationMs: Date.now() - started,
      });
    },
  };
}
