import {
  buildProjectInstructions,
} from '../../../core/runs/project_instructions.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  PROJECT_INSTRUCTIONS_INPUT_SCHEMA,
  rejectUnknownKeys,
  validateBoolean,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_project_instructions';
const ALLOWED_KEYS = new Set(['include_docs']);

function renderText(payload: {
  source: string;
  run_id?: string;
  instructions: Array<{ path: string; bytes: number; truncated: boolean }>;
  docs: Array<{ path: string; bytes: number; truncated: boolean }>;
}): string {
  const lines: string[] = ['# Vibecode project instructions', ''];
  lines.push(`source: ${payload.source}`);
  if (payload.run_id) lines.push(`run_id: ${payload.run_id}`);
  lines.push('');
  lines.push('instructions:');
  if (payload.instructions.length === 0) {
    lines.push('  (none)');
  } else {
    for (const entry of payload.instructions) {
      lines.push(`  - ${entry.path} (${entry.bytes} bytes${entry.truncated ? ', truncated' : ''})`);
    }
  }
  if (payload.docs.length > 0) {
    lines.push('');
    lines.push('docs:');
    for (const entry of payload.docs) {
      lines.push(`  - ${entry.path} (${entry.bytes} bytes${entry.truncated ? ', truncated' : ''})`);
    }
  }
  return lines.join('\n');
}

export function buildProjectInstructionsTool(): McpToolDefinition {
  const inputSchema: JsonSchema = PROJECT_INSTRUCTIONS_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode project instructions',
    description:
      'Bounded project instructions for coding agents (AGENTS.md, CONTRIBUTING.md, README.md, docs/codegraph.md). Prefers the current run\'s scan/repo_instructions.json artifact, falling back to a strict allowlisted set of repo files. Read-only — never reads arbitrary paths or source files.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const args = (input.arguments ?? {}) as Record<string, unknown>;

      const unknown = rejectUnknownKeys(args, ALLOWED_KEYS);
      if (!unknown.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', unknown.message),
        });
      }
      const includeDocs = validateBoolean(args.include_docs, 'include_docs');
      if (!includeDocs.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', includeDocs.message),
        });
      }

      const result = buildProjectInstructions(input.context.repoRoot, {
        include_docs: includeDocs.value ?? false,
      });
      if (result.source === 'none') {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: result.warnings,
          durationMs: Date.now() - started,
          error: buildMcpError(
            'PROJECT_INSTRUCTIONS_NOT_FOUND',
            'No allowlisted project instructions found (no scan/repo_instructions.json and no AGENTS.md/CONTRIBUTING.md/README.md/docs/codegraph.md).',
          ),
        });
      }

      const data = {
        source: result.source,
        run_id: result.run_id,
        instructions: result.instructions,
        docs: result.docs,
        authority_order: [
          'AGENTS.md',
          'docs/ARCHITECTURE_DECISIONS.md',
          'docs/IMPLEMENTATION_MAP.md',
          'docs/ARCHITECTURE.md',
        ],
      };
      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText({
          source: result.source,
          run_id: result.run_id,
          instructions: result.instructions,
          docs: result.docs,
        }),
        data,
        warnings: result.warnings,
        durationMs: Date.now() - started,
      });
    },
  };
}
