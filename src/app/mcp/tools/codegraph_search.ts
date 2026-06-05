import {
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import {
  runCodeGraphSearch,
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
  rejectUnknownKeys,
  SEARCH_INPUT_SCHEMA,
  validateNonEmptyString,
  validatePositiveInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_codegraph_search';
const ALLOWED_KEYS = new Set(['query', 'maxResults', 'timeoutMs']);

export interface CodeGraphSearchToolDeps {
  runner?: CodeGraphQueryRunner;
  binary?: CodeGraphBinaryResolution;
}

export function buildCodeGraphSearchTool(deps: CodeGraphSearchToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = SEARCH_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'CodeGraph search',
    description:
      'Search for symbols in the indexed Vibecode-bound repo. Prefer this over grep/find for code navigation when CodeGraph is initialized. Read-only. Returns raw upstream rank scores (NOT percentages). Use rg/grep for literal text and error messages.',
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
      const maxResults = validatePositiveInteger(args.maxResults, 'maxResults');
      if (!maxResults.ok) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', maxResults.message),
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
      const result = runCodeGraphSearch({
        repoRoot: input.context.repoRoot,
        query: query.value,
        command: binary.command,
        binarySource: binary.source,
        json: true,
        ...(maxResults.value !== undefined ? { maxResults: maxResults.value } : {}),
        ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
        ...(deps.runner ? { runner: deps.runner } : {}),
      });

      const durationMs = Date.now() - started;
      if (!result.ok) {
        return formatQueryResultFailure({ tool: TOOL_NAME, result, durationMs });
      }
      const text = renderSearchText(result.stdoutText ?? '', query.value);
      return formatQueryResultSuccess({
        tool: TOOL_NAME,
        text,
        data: {
          parsed_json: result.parsedJson,
          score_meta: result.scoreMeta,
        },
        result,
        durationMs,
      });
    },
  };
}

function renderSearchText(stdoutText: string, query: string): string {
  const lines: string[] = [];
  lines.push('# CodeGraph Search');
  lines.push('');
  lines.push(`Query: ${query}`);
  lines.push('');
  const trimmed = stdoutText.trimEnd();
  lines.push(trimmed.length > 0 ? trimmed : '(no results)');
  return lines.join('\n');
}
