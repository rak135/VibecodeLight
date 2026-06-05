import {
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import {
  runCodeGraphCallees,
  runCodeGraphCallers,
  runCodeGraphImpact,
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
  IMPACT_INPUT_SCHEMA,
  SYMBOL_INPUT_SCHEMA,
  rejectUnknownKeys,
  validateNonEmptyString,
  validatePositiveInteger,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

export interface CodeGraphSymbolToolDeps {
  runner?: CodeGraphQueryRunner;
  binary?: CodeGraphBinaryResolution;
}

interface SymbolToolConfig {
  name: string;
  title: string;
  description: string;
  schema: JsonSchema;
  symbolKey: 'symbol' | 'input';
  invoke: typeof runCodeGraphCallers;
  textHeader: string;
}

function buildSymbolTool(config: SymbolToolConfig, deps: CodeGraphSymbolToolDeps): McpToolDefinition {
  const allowed = new Set([config.symbolKey, 'limit', 'timeoutMs']);
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.schema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const args = (input.arguments ?? {}) as Record<string, unknown>;

      const unknown = rejectUnknownKeys(args, allowed);
      if (!unknown.ok) {
        return formatError({
          tool: config.name,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', unknown.message),
        });
      }
      const symbolRaw = args[config.symbolKey];
      const symbol = validateNonEmptyString(symbolRaw, config.symbolKey);
      if (!symbol.ok) {
        return formatError({
          tool: config.name,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', symbol.message),
        });
      }
      const limit = validatePositiveInteger(args.limit, 'limit');
      if (!limit.ok) {
        return formatError({
          tool: config.name,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', limit.message),
        });
      }
      const timeoutMs = validatePositiveInteger(args.timeoutMs, 'timeoutMs');
      if (!timeoutMs.ok) {
        return formatError({
          tool: config.name,
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
      const result = config.invoke({
        repoRoot: input.context.repoRoot,
        symbol: symbol.value,
        command: binary.command,
        binarySource: binary.source,
        json: true,
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
        ...(deps.runner ? { runner: deps.runner } : {}),
      });

      const durationMs = Date.now() - started;
      if (!result.ok) {
        return formatQueryResultFailure({ tool: config.name, result, durationMs });
      }
      const text = [
        `# ${config.textHeader}`,
        '',
        `${config.symbolKey === 'symbol' ? 'Symbol' : 'Input'}: ${symbol.value}`,
        '',
        (result.stdoutText ?? '').trimEnd() || '(no results)',
      ].join('\n');
      return formatQueryResultSuccess({
        tool: config.name,
        text,
        data: { parsed_json: result.parsedJson },
        result,
        durationMs,
      });
    },
  };
}

export function buildCodeGraphCallersTool(deps: CodeGraphSymbolToolDeps = {}): McpToolDefinition {
  return buildSymbolTool({
    name: 'vibecode_codegraph_callers',
    title: 'CodeGraph callers',
    description: 'Return callers of an indexed symbol. Prefer this over grepping when tracing call graphs. Symbol must be exactly as indexed — use vibecode_codegraph_context or vibecode_codegraph_search first to find the canonical name. Read-only.',
    schema: SYMBOL_INPUT_SCHEMA,
    symbolKey: 'symbol',
    invoke: runCodeGraphCallers,
    textHeader: 'CodeGraph Callers',
  }, deps);
}

export function buildCodeGraphCalleesTool(deps: CodeGraphSymbolToolDeps = {}): McpToolDefinition {
  return buildSymbolTool({
    name: 'vibecode_codegraph_callees',
    title: 'CodeGraph callees',
    description: 'Return callees of an indexed symbol. Prefer this over grepping when tracing call graphs. Symbol must be exactly as indexed — find it via vibecode_codegraph_context or vibecode_codegraph_search first. Read-only.',
    schema: SYMBOL_INPUT_SCHEMA,
    symbolKey: 'symbol',
    invoke: runCodeGraphCallees,
    textHeader: 'CodeGraph Callees',
  }, deps);
}

export function buildCodeGraphImpactTool(deps: CodeGraphSymbolToolDeps = {}): McpToolDefinition {
  return buildSymbolTool({
    name: 'vibecode_codegraph_impact',
    title: 'CodeGraph impact',
    description: 'Traverse change-impact for a symbol or path against the existing CodeGraph index. Prefer this over manual reasoning when estimating blast radius. `limit` maps to upstream --depth. Read-only.',
    schema: IMPACT_INPUT_SCHEMA,
    symbolKey: 'input',
    invoke: runCodeGraphImpact,
    textHeader: 'CodeGraph Impact',
  }, deps);
}
