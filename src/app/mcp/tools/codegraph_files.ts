import {
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import {
  runCodeGraphFiles,
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
  FILES_INPUT_SCHEMA,
  rejectUnknownKeys,
  validatePositiveInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_codegraph_files';
const ALLOWED_KEYS = new Set(['limit', 'timeoutMs']);

export interface CodeGraphFilesToolDeps {
  runner?: CodeGraphQueryRunner;
  binary?: CodeGraphBinaryResolution;
}

export function buildCodeGraphFilesTool(deps: CodeGraphFilesToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = FILES_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'CodeGraph files',
    description: 'List the indexed project file structure from the existing CodeGraph index. Prefer this over walking the filesystem by hand. Read-only.',
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
      const limit = validatePositiveInteger(args.limit, 'limit');
      if (!limit.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', limit.message),
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
      const result = runCodeGraphFiles({
        repoRoot: input.context.repoRoot,
        command: binary.command,
        binarySource: binary.source,
        json: true,
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
        ...(deps.runner ? { runner: deps.runner } : {}),
      });

      const durationMs = Date.now() - started;
      if (!result.ok) {
        return formatQueryResultFailure({ tool: TOOL_NAME, result, durationMs });
      }
      const text = ['# CodeGraph Files', '', (result.stdoutText ?? '').trimEnd() || '(no files)'].join('\n');
      return formatQueryResultSuccess({
        tool: TOOL_NAME,
        text,
        data: { parsed_json: result.parsedJson },
        result,
        durationMs,
      });
    },
  };
}
