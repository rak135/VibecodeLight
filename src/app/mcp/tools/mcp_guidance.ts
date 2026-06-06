import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  MCP_GUIDANCE_INPUT_SCHEMA,
  rejectUnknownKeys,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_mcp_guidance';
const ALLOWED_KEYS = new Set<string>();

/**
 * Static guidance text. Kept short and practical. No filesystem reads, no
 * external services, no dynamic secrets — calling this tool is a pure
 * lookup so an agent can fetch the "what to call when" cheat sheet without
 * having to scroll a long readme.
 */
const GUIDANCE_SECTIONS: ReadonlyArray<{ heading: string; bullets: readonly string[] }> = Object.freeze([
  {
    heading: 'Start here',
    bullets: [
      'Call vibecode_workspace_info to learn the bound repo, available tools, and CodeGraph status.',
      'Call vibecode_workspace_status to see git branch/head/dirty and the current run.',
    ],
  },
  {
    heading: 'Code navigation',
    bullets: [
      'Prefer vibecode_codegraph_search/_context/_callers/_callees/_impact over raw grep/find.',
      'Use vibecode_codegraph_files to list indexed files; vibecode_codegraph_status to check freshness.',
    ],
  },
  {
    heading: 'Vibecode run history',
    bullets: [
      'vibecode_runs_list, vibecode_current_run, vibecode_run_get for run-level inspection.',
      'vibecode_artifacts_list to discover allowlisted artifacts for a run before reading any.',
      'vibecode_artifact_read for one allowlisted artifact at a time (final_prompt, context_pack, …).',
      'vibecode_codegraph_usage for the per-run CodeGraph transport/fallback summary.',
    ],
  },
  {
    heading: 'Repo conventions',
    bullets: [
      'Call vibecode_project_instructions before implementation or review tasks.',
      'AGENTS.md authority order applies: AGENTS.md > ARCHITECTURE_DECISIONS.md > IMPLEMENTATION_MAP.md > ARCHITECTURE.md.',
    ],
  },
  {
    heading: 'When to escape MCP',
    bullets: [
      'Use rg/grep for exact literal text, error messages, and log scraping.',
      'Fall back to the Vibecode CLI (`vibecode codegraph …`, `vibecode runs …`) when MCP is unavailable.',
      'Do not call upstream CodeGraph (`codegraph serve --mcp`) directly — go through VibecodeMCP.',
    ],
  },
  {
    heading: 'Approvals',
    bullets: [
      'Vibecode does not manage approvals. The MCP client/agent (Codex /mcp, Claude managed approvals UI) owns permission and trust.',
    ],
  },
]);

function renderText(): string {
  const lines: string[] = ['# VibecodeMCP usage guide', ''];
  for (const section of GUIDANCE_SECTIONS) {
    lines.push(`## ${section.heading}`);
    for (const bullet of section.bullets) lines.push(`- ${bullet}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function buildMcpGuidanceTool(): McpToolDefinition {
  const inputSchema: JsonSchema = MCP_GUIDANCE_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'VibecodeMCP usage guide',
    description:
      'Compact, structured guide describing when to use each VibecodeMCP tool, when to fall back to the Vibecode CLI, and when to use rg/grep. Read-only, static content.',
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

      const data = {
        sections: GUIDANCE_SECTIONS.map((section) => ({
          heading: section.heading,
          bullets: [...section.bullets],
        })),
      };

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(),
        data,
        durationMs: Date.now() - started,
      });
    },
  };
}
