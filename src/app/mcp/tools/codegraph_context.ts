import {
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import {
  runCodeGraphContextQuery,
  type CodeGraphQueryRunner,
} from '../../../adapters/codegraph/codegraph_query_commands.js';
import { buildMcpError } from '../errors.js';
import {
  formatError,
  formatQueryResultFailure,
  formatQueryResultSuccess,
  type McpToolFormattedResult,
} from '../format.js';
import {
  CONTEXT_INPUT_SCHEMA,
  rejectUnknownKeys,
  validateNonEmptyString,
  validatePositiveInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_codegraph_context';
const ALLOWED_KEYS = new Set(['query', 'maxNodes', 'maxCode', 'timeoutMs']);

export interface CodeGraphContextToolDeps {
  runner?: CodeGraphQueryRunner;
  binary?: CodeGraphBinaryResolution;
}

export function buildCodeGraphContextTool(deps: CodeGraphContextToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = CONTEXT_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'CodeGraph context',
    description: 'Build bounded markdown context for a task from the existing CodeGraph index. Read-only.',
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
      const query = validateNonEmptyString(args.query, 'query');
      if (!query.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', query.message),
        });
      }
      const maxNodes = validatePositiveInteger(args.maxNodes, 'maxNodes');
      if (!maxNodes.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', maxNodes.message),
        });
      }
      const maxCode = validatePositiveInteger(args.maxCode, 'maxCode');
      if (!maxCode.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', maxCode.message),
        });
      }
      const timeoutMs = validatePositiveInteger(args.timeoutMs, 'timeoutMs');
      if (!timeoutMs.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', timeoutMs.message),
        });
      }

      const binary = deps.binary ?? resolveCodeGraphBinary({
        cliOption: input.context.codegraphBinary ?? null,
        env: process.env,
      });
      const result = runCodeGraphContextQuery({
        repoRoot: input.context.repoRoot,
        query: query.value,
        command: binary.command,
        binarySource: binary.source,
        ...(maxNodes.value !== undefined ? { maxNodes: maxNodes.value } : {}),
        ...(maxCode.value !== undefined ? { maxCode: maxCode.value } : {}),
        ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
        ...(deps.runner ? { runner: deps.runner } : {}),
      });

      const durationMs = Date.now() - started;
      if (!result.ok) {
        return formatQueryResultFailure({ tool: TOOL_NAME, result, durationMs });
      }
      const text = ['# CodeGraph Context', '', `Query: ${query.value}`, '', (result.stdoutText ?? '').trimEnd() || '(no context)'].join('\n');
      return formatQueryResultSuccess({
        tool: TOOL_NAME,
        text,
        data: { stdoutText: result.stdoutText },
        result,
        durationMs,
      });
    },
  };
}
