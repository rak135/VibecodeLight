import {
  getCodeGraphStatus,
  type CodeGraphActionRunner,
} from '../../../adapters/codegraph/codegraph_actions.js';
import {
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatStatusSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  STATUS_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolHandlerInput, McpToolDefinition } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_codegraph_status';
const ALLOWED_KEYS = new Set<string>();

export interface CodeGraphStatusToolDeps {
  /** Test seam: injected upstream-call runner. */
  runner?: CodeGraphActionRunner;
  /** Test seam: override the binary resolution result. */
  binary?: CodeGraphBinaryResolution;
}

export function buildCodeGraphStatusTool(deps: CodeGraphStatusToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = STATUS_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'CodeGraph status',
    description:
      'Detect whether upstream CodeGraph is installed and whether the repo has an initialized index. Call this first to know whether the other vibecode_codegraph_* tools will work. Read-only.',
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

      const binary = deps.binary ?? resolveCodeGraphBinary({
        cliOption: input.context.codegraphBinary ?? null,
        env: process.env,
      });
      const status = await getCodeGraphStatus(input.context.repoRoot, {
        command: binary.command,
        binary,
        ...(deps.runner ? { runner: deps.runner } : {}),
      });
      return formatStatusSuccess({
        repoRoot: input.context.repoRoot,
        status,
        durationMs: Date.now() - started,
      });
    },
  };
}
