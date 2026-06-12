import fs from 'fs';

import {
  getCodeGraphStatus,
  type CodeGraphActionRunner,
  type CodeGraphStatusResult,
} from '../../../adapters/codegraph/codegraph_actions.js';
import {
  resolveCodeGraphBinary,
  type CodeGraphBinaryResolution,
} from '../../../adapters/codegraph/codegraph_binary_resolver.js';
import { LlmAdapterError } from '../../../adapters/llm/errors.js';
import { resolveRunDir } from '../../../core/runs/run_resolver.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  WORKSPACE_INFO_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { buildMcpServerIdentity, type McpServerIdentity } from '../server_identity.js';
import {
  buildAgentGuidanceRuntime,
  buildGuidanceStatusSummary,
} from '../../../core/agent_guidance/agent_guidance_runtime.js';
import { listToolProfileSummaries } from '../../../core/agent_guidance/tool_profiles.js';
import { AGENT_GUIDANCE_MCP_TOOL_GROUPS } from '../../../core/config/agent_guidance_mcp_tools.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../tool_registry.js';

const TOOL_NAME = 'vibecode_workspace_info';
const ALLOWED_KEYS = new Set<string>();

/** MCP server identity exported so workspace_info reports a stable name/version. */
export const WORKSPACE_INFO_SERVER_NAME = 'vibecode-mcp';
export const WORKSPACE_INFO_SERVER_VERSION = '0.1.0';

const AGENT_GUIDANCE = Object.freeze([
  'Use VibecodeMCP first for repo navigation and Vibecode run artifacts.',
  'Fall back to the Vibecode CLI (`vibecode codegraph …`, `vibecode runs …`) only when MCP is unavailable.',
  'Use rg/grep for exact literal text, logs, and raw error messages.',
  'Do not call upstream CodeGraph (`codegraph serve --mcp`) directly — go through these Vibecode tools.',
  'Vibecode does not manage approvals; the MCP client/agent owns permission/trust decisions.',
]);

export interface WorkspaceInfoToolDeps {
  /** Test seam: override CodeGraph status resolution entirely. */
  codegraphStatus?: (repoRoot: string) => Promise<CodeGraphStatusResult>;
  /** Test seam: override the upstream-call runner used by the default status path. */
  runner?: CodeGraphActionRunner;
  /** Test seam: override the binary resolution result. */
  binary?: CodeGraphBinaryResolution;
  /** Test seam: override Agent Guidance config environment. */
  env?: Record<string, string | undefined>;
}

function safeCurrentRunSummary(repoRoot: string): { run_id: string; run_dir: string } | null {
  try {
    const { runId, runDir } = resolveRunDir(repoRoot, 'latest');
    if (!fs.existsSync(runDir)) return null;
    return { run_id: runId, run_dir: runDir };
  } catch (err) {
    // Non-fatal: no current run pointer is a normal state for a fresh repo.
    if (err instanceof LlmAdapterError) return null;
    return null;
  }
}

function renderText(data: {
  repo_root: string;
  mcp_server: { name: string; version: string };
  server_identity: McpServerIdentity;
  tools: { total: number; groups: Record<string, string[]> };
  codegraph: { available: boolean; initialized: boolean; version?: string | null };
  current_run: { run_id: string } | null;
  agent_guidance: readonly string[];
  guidance_status?: {
    enabled: boolean;
    source: string;
    guidance_hash: string;
    config_path: string;
    recommendation: string;
  };
}): string {
  const lines: string[] = ['# Vibecode workspace info', ''];
  lines.push(`repo_root: ${data.repo_root}`);
  lines.push(`mcp_server: ${data.mcp_server.name} ${data.mcp_server.version}`);
  lines.push(
    `server_identity: tool_count=${data.server_identity.tool_count}`
      + ` version=${data.server_identity.server_version}`
      + ` started_at=${data.server_identity.started_at}`
      + ' (compare against the current build to detect a stale MCP server session)',
  );
  lines.push(`tools_total: ${data.tools.total}`);
  for (const [group, names] of Object.entries(data.tools.groups)) {
    lines.push(`  ${group}: ${names.length}`);
  }
  lines.push('');
  lines.push(
    `codegraph: available=${data.codegraph.available ? 'yes' : 'no'} initialized=${
      data.codegraph.initialized ? 'yes' : 'no'
    }${data.codegraph.version ? ` version=${data.codegraph.version}` : ''}`,
  );
  if (data.current_run) {
    lines.push(`current_run: ${data.current_run.run_id}`);
  } else {
    lines.push('current_run: (none — call vibecode prompt or vibecode context-build first)');
  }
  lines.push('');
  lines.push('agent_guidance:');
  for (const line of data.agent_guidance) lines.push(`  - ${line}`);
  if (data.guidance_status) {
    lines.push('');
    lines.push('guidance_status:');
    lines.push(`  enabled: ${data.guidance_status.enabled ? 'yes' : 'no'}`);
    lines.push(`  source: ${data.guidance_status.source}`);
    lines.push(`  guidance_hash: ${data.guidance_status.guidance_hash}`);
    lines.push(`  config_path: ${data.guidance_status.config_path}`);
    lines.push(`  recommendation: ${data.guidance_status.recommendation}`);
  }
  return lines.join('\n');
}

export function buildWorkspaceInfoTool(deps: WorkspaceInfoToolDeps = {}): McpToolDefinition {
  const inputSchema: JsonSchema = WORKSPACE_INFO_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode workspace info',
    description:
      'Workspace identity and MCP capability summary. Start here when entering a repo to learn the bound repo path, available VibecodeMCP tools, CodeGraph status, and the current run. Read-only.',
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

      // CodeGraph status is non-fatal — failures become warnings, not errors.
      const warnings: string[] = [];
      let status: CodeGraphStatusResult;
      try {
        if (deps.codegraphStatus) {
          status = await deps.codegraphStatus(input.context.repoRoot);
        } else {
          const binary =
            deps.binary ??
            resolveCodeGraphBinary({ cliOption: input.context.codegraphBinary ?? null, env: process.env });
          status = await getCodeGraphStatus(input.context.repoRoot, {
            command: binary.command,
            binary,
            ...(deps.runner ? { runner: deps.runner } : {}),
          });
        }
      } catch (err) {
        status = {
          ok: false,
          available: false,
          initialized: false,
          warnings: [err instanceof Error ? err.message : String(err)],
        };
      }
      if (!status.available) {
        warnings.push('CODEGRAPH_UNAVAILABLE: upstream CodeGraph binary is not detected; CodeGraph navigation tools will return CODEGRAPH_NOT_INSTALLED.');
      } else if (!status.initialized) {
        warnings.push('CODEGRAPH_NOT_INITIALIZED: run `vibecode codegraph init --repo <path>` once to initialize the index.');
      }
      for (const w of status.warnings) warnings.push(w);

      const currentRun = safeCurrentRunSummary(input.context.repoRoot);
      const runtime = input.context.agentGuidance ?? buildAgentGuidanceRuntime({ env: deps.env });
      const guidanceStatus = buildGuidanceStatusSummary(runtime);
      const data = {
        repo_root: input.context.repoRoot,
        mcp_server: { name: WORKSPACE_INFO_SERVER_NAME, version: WORKSPACE_INFO_SERVER_VERSION },
        // Phase 2D follow-up: compact identity of the RUNNING server build so
        // agents can detect a stale MCP server session (e.g. tool_count drift).
        server_identity: buildMcpServerIdentity(input.context.repoRoot),
        tools: {
          total: VIBECODE_MCP_TOOL_NAMES.length,
          groups: Object.fromEntries(
            Object.entries(AGENT_GUIDANCE_MCP_TOOL_GROUPS).map(([group, names]) => [group, [...names]]),
          ),
        },
        codegraph: {
          available: status.available,
          initialized: status.initialized,
          version: status.version ?? null,
          binary_source: status.binary?.source ?? null,
        },
        current_run: currentRun,
        agent_guidance: [...AGENT_GUIDANCE],
        guidance_status: guidanceStatus,
        // Phase 1B-3: compact list of available tool profiles (ids/titles only,
        // not the full recommended tool sets). Call vibecode_tool_profile for one.
        tool_profiles: listToolProfileSummaries(),
      };

      return formatSimpleSuccess({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        text: renderText(data),
        data,
        warnings,
        durationMs: Date.now() - started,
      });
    },
  };
}
