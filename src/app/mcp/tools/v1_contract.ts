import { addBulkClaims } from '../../../core/coordination/bulk_claims.js';
import { planClaims } from '../../../core/coordination/claim_planning.js';
import { CoordinationError } from '../../../core/coordination/errors.js';
import { getFinalizeCheck } from '../../../core/coordination/finalize_check.js';
import { getGitChangedFiles } from '../../../core/workspace/git_changed_files.js';
import { releaseClaimIntent } from '../../../core/coordination/intent_lifecycle.js';
import { loadCoordinationState, writeCoordinationState } from '../../../core/coordination/state.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoolean,
  validateBoundedInteger,
  validateNonEmptyString,
  validateStringArray,
  HARD_MAX_ARTIFACT_BYTES,
  HARD_MAX_BOOTSTRAP_ITEMS,
  HARD_MAX_GIT_CHANGES_FILES,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { buildArtifactReadTool } from './artifact_read.js';
import { buildCodeGraphContextTool } from './codegraph_context.js';
import { buildCodeGraphSearchTool } from './codegraph_search.js';
import {
  buildCodeGraphCallersTool,
  buildCodeGraphImpactTool,
} from './codegraph_symbol.js';
import { buildGitChangesTool } from './git_changes.js';
import { buildHandoffGuideTool } from './handoff_guide.js';
import { buildHandoffPrepareTool } from './handoff_prepare.js';
import { buildProjectInstructionsTool } from './project_instructions.js';
import { buildRunGetTool } from './run_get.js';
import { buildScanArtifactReadTool } from './scan_artifact_read.js';
import { buildSessionBootstrapTool } from './session_bootstrap.js';
import { buildWorkspaceStatusTool } from './workspace_status.js';

const TOOL_NAMES = {
  sessionStart: 'vibecode_session_start',
  workspaceSnapshot: 'vibecode_workspace_snapshot',
  projectInstructions: 'vibecode_project_instructions',
  runStatus: 'vibecode_run_status',
  artifactRead: 'vibecode_artifact_read',
  changes: 'vibecode_changes',
  codegraphSearch: 'vibecode_codegraph_search',
  codegraphExplore: 'vibecode_codegraph_explore',
  codegraphCallers: 'vibecode_codegraph_callers',
  codegraphImpact: 'vibecode_codegraph_impact',
  buildStart: 'vibecode_build_start',
  buildScope: 'vibecode_build_scope',
  buildFinish: 'vibecode_build_finish',
  handoff: 'vibecode_handoff',
} as const;

const POSITIVE_INT: JsonSchema = { type: 'integer', minimum: 1 };

const OLD_TO_V1_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  vibecode_session_bootstrap: TOOL_NAMES.sessionStart,
  vibecode_agent_register: TOOL_NAMES.sessionStart,
  vibecode_agent_heartbeat: TOOL_NAMES.sessionStart,
  vibecode_agents_list: TOOL_NAMES.workspaceSnapshot,
  vibecode_agent_status: TOOL_NAMES.workspaceSnapshot,
  vibecode_workspace_info: TOOL_NAMES.workspaceSnapshot,
  vibecode_workspace_status: TOOL_NAMES.workspaceSnapshot,
  vibecode_coordination_status: TOOL_NAMES.workspaceSnapshot,
  vibecode_team_status: TOOL_NAMES.workspaceSnapshot,
  vibecode_tool_profile: TOOL_NAMES.workspaceSnapshot,
  vibecode_runs_list: TOOL_NAMES.runStatus,
  vibecode_current_run: TOOL_NAMES.runStatus,
  vibecode_run_get: TOOL_NAMES.runStatus,
  vibecode_scan_summary: TOOL_NAMES.runStatus,
  vibecode_scan_artifact_read: TOOL_NAMES.artifactRead,
  vibecode_git_changes: TOOL_NAMES.changes,
  vibecode_evidence_list: TOOL_NAMES.changes,
  vibecode_evidence_scan: TOOL_NAMES.changes,
  vibecode_codegraph_context: TOOL_NAMES.codegraphExplore,
  vibecode_codegraph_files: TOOL_NAMES.codegraphExplore,
  vibecode_codegraph_status: TOOL_NAMES.codegraphExplore,
  vibecode_codegraph_usage: TOOL_NAMES.codegraphExplore,
  vibecode_codegraph_callees: TOOL_NAMES.codegraphCallers,
  vibecode_claim_add: TOOL_NAMES.buildStart,
  vibecode_claims_plan: TOOL_NAMES.buildStart,
  vibecode_claims_add_bulk: TOOL_NAMES.buildStart,
  vibecode_claim_status: TOOL_NAMES.buildScope,
  vibecode_claims_list: TOOL_NAMES.buildScope,
  vibecode_claim_release: TOOL_NAMES.buildScope,
  vibecode_claim_intents_list: TOOL_NAMES.buildScope,
  vibecode_claim_intent_release: TOOL_NAMES.buildScope,
  vibecode_claims_reap: TOOL_NAMES.buildScope,
  vibecode_conflicts_list: TOOL_NAMES.workspaceSnapshot,
  vibecode_conflict_detail: TOOL_NAMES.workspaceSnapshot,
  vibecode_conflict_resolve: TOOL_NAMES.buildScope,
  vibecode_finalize_check: TOOL_NAMES.buildFinish,
  vibecode_handoff_prepare: TOOL_NAMES.handoff,
  vibecode_handoff_guide: TOOL_NAMES.handoff,
});

const OLD_TOOL_NAME_PATTERN = new RegExp(Object.keys(OLD_TO_V1_TOOL_NAMES).join('|'), 'g');

function sanitizeV1ToolNames(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(OLD_TOOL_NAME_PATTERN, (match) => OLD_TO_V1_TOOL_NAMES[match] ?? match);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeV1ToolNames(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeV1ToolNames(child);
    }
    return out;
  }
  return value;
}

const SESSION_START_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    agent_name: { type: 'string' },
    mode: { type: 'string', enum: ['read_only', 'build'] },
    task: { type: 'string' },
    terminal_id: { type: 'string' },
    resume: { type: 'boolean' },
  },
  required: ['mode', 'task'],
};

const WORKSPACE_SNAPSHOT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    include: { type: 'array', items: { type: 'string' } },
    max_items: POSITIVE_INT,
  },
};

const PROJECT_INSTRUCTIONS_V1_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    task: { type: 'string' },
    max_chars: POSITIVE_INT,
    include_sources: { type: 'boolean' },
  },
};

const RUN_STATUS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    run_ref: { type: 'string' },
    max_items: POSITIVE_INT,
  },
};

const ARTIFACT_READ_V1_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    run_ref: { type: 'string' },
    artifact_type: { type: 'string', enum: ['run', 'scan'] },
    artifact_key: { type: 'string' },
    cursor: { type: 'string' },
    max_bytes: { ...POSITIVE_INT, maximum: HARD_MAX_ARTIFACT_BYTES },
  },
  required: ['artifact_type', 'artifact_key'],
};

const CHANGES_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    intent_id: { type: 'string' },
    include_diff_stat: { type: 'boolean' },
    max_items: { ...POSITIVE_INT, maximum: HARD_MAX_GIT_CHANGES_FILES },
  },
};

const CODEGRAPH_SEARCH_V1_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    query: { type: 'string' },
    kind: { type: 'string', enum: ['symbol', 'file', 'any'] },
    max_results: POSITIVE_INT,
  },
  required: ['query'],
};

const CODEGRAPH_EXPLORE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    topic: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    max_items: POSITIVE_INT,
  },
  required: ['topic'],
};

const CODEGRAPH_CALLERS_V1_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    symbol: { type: 'string' },
    path: { type: 'string' },
    max_depth: POSITIVE_INT,
    max_items: POSITIVE_INT,
  },
  required: ['symbol'],
};

const CODEGRAPH_IMPACT_V1_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          symbol: { type: 'string' },
        },
      },
    },
    max_depth: POSITIVE_INT,
    max_items: POSITIVE_INT,
  },
  required: ['targets'],
};

const BUILD_START_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    task: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    dry_run: { type: 'boolean' },
    intent_id: { type: 'string' },
  },
  required: ['agent_id', 'paths'],
};

const BUILD_SCOPE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    intent_id: { type: 'string' },
    add_paths: { type: 'array', items: { type: 'string' } },
    release_paths: { type: 'array', items: { type: 'string' } },
    dry_run: { type: 'boolean' },
  },
  required: ['agent_id', 'intent_id'],
};

const BUILD_FINISH_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    intent_id: { type: 'string' },
    release_clean_claims: { type: 'boolean' },
    include_commit_guard_command: { type: 'boolean' },
  },
  required: ['agent_id'],
};

const HANDOFF_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string' },
    mode: { type: 'string', enum: ['prepare', 'guide'] },
    from_agent_id: { type: 'string' },
    for_agent_id: { type: 'string' },
    max_items: POSITIVE_INT,
  },
  required: ['mode'],
};

function retag(result: McpToolFormattedResult, tool: string, data?: unknown): McpToolFormattedResult {
  const nextData = sanitizeV1ToolNames(data !== undefined ? data : result.structuredContent.data);
  return {
    ...result,
    content: result.content.map((entry) =>
      entry.type === 'text' && typeof entry.text === 'string'
        ? { ...entry, text: sanitizeV1ToolNames(entry.text) as string }
        : entry,
    ),
    structuredContent: {
      ...result.structuredContent,
      tool,
      ...(nextData !== undefined ? { data: nextData } : {}),
    },
  };
}

function fail(input: McpToolHandlerInput, tool: string, started: number, code: McpErrorCode, message: string): McpToolFormattedResult {
  return formatError({
    tool,
    repoRoot: input.context.repoRoot,
    warnings: [],
    durationMs: Date.now() - started,
    error: buildMcpError(code, message),
  });
}

function coordCode(error: CoordinationError, fallback: McpErrorCode): McpErrorCode {
  switch (error.code) {
    case 'AGENT_NOT_FOUND':
      return 'AGENT_NOT_FOUND';
    case 'AGENT_NOT_ACTIVE':
      return 'AGENT_NOT_ACTIVE';
    case 'READ_ONLY_AGENT':
      return 'READ_ONLY_AGENT';
    case 'INVALID_AGENT_MODE':
    case 'INVALID_AGENT_SESSION':
      return 'INVALID_AGENT_SESSION';
    case 'NO_CLAIM_PATHS':
      return 'NO_CLAIM_PATHS';
    case 'INVALID_INTENT':
      return 'INVALID_INTENT';
    case 'INTENT_NOT_FOUND':
      return 'INTENT_NOT_FOUND';
    case 'INTENT_FORBIDDEN':
      return 'INTENT_FORBIDDEN';
    default:
      return fallback;
  }
}

function cursorToOffset(cursor: unknown): number | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor === 'number') return cursor;
  if (typeof cursor === 'string' && /^\d+$/.test(cursor)) return Number(cursor);
  return Number.NaN;
}

export function buildV1SessionStartTool(): McpToolDefinition {
  const legacy = buildSessionBootstrapTool();
  return {
    name: TOOL_NAMES.sessionStart,
    title: 'Vibecode session start',
    description: 'Start or resume an agent session. Required first call for VibecodeMCP agents; writes only generated coordination session metadata.',
    inputSchema: SESSION_START_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'agent_name', 'mode', 'task', 'terminal_id', 'resume']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.sessionStart, started, 'INVALID_ARGUMENT', unknown.message);
      const args = input.arguments ?? {};
      const mode = validateNonEmptyString(args.mode, 'mode');
      if (!mode.ok) return fail(input, TOOL_NAMES.sessionStart, started, 'INVALID_ARGUMENT', mode.message);
      if (!['read_only', 'build'].includes(mode.value)) {
        return fail(input, TOOL_NAMES.sessionStart, started, 'INVALID_ARGUMENT', 'mode must be read_only or build');
      }
      const task = validateNonEmptyString(args.task, 'task');
      if (!task.ok) return fail(input, TOOL_NAMES.sessionStart, started, 'INVALID_ARGUMENT', task.message);
      if (args.resume !== undefined && args.resume !== null && typeof args.resume !== 'boolean') {
        return fail(input, TOOL_NAMES.sessionStart, started, 'INVALID_ARGUMENT', 'resume must be a boolean');
      }
      const agentId = args.agent_id === undefined || args.agent_id === null ? undefined : validateNonEmptyString(args.agent_id, 'agent_id');
      if (agentId && !agentId.ok) return fail(input, TOOL_NAMES.sessionStart, started, 'INVALID_ARGUMENT', agentId.message);
      const result = await legacy.handler({
        ...input,
        arguments: {
          ...(agentId ? { agent_id: agentId.value } : { register: true }),
          agent_mode: mode.value,
          agent_name: typeof args.agent_name === 'string' ? args.agent_name : 'MCP agent',
          agent_type: 'custom',
          task: task.value,
          terminal_session_id: typeof args.terminal_id === 'string' ? args.terminal_id : undefined,
          max_items: HARD_MAX_BOOTSTRAP_ITEMS,
        },
      });
      const old = result.structuredContent.data as Record<string, unknown> | undefined;
      const current = old?.current_agent as Record<string, unknown> | undefined;
      const data = {
        ok: !result.isError,
        agent_id: current?.agent_id ?? agentId?.value ?? null,
        session_id: current?.agent_id ?? agentId?.value ?? null,
        mode: current?.operating_mode ?? mode.value,
        status: result.isError ? 'rejected' : agentId ? 'resumed' : 'active',
        last_activity_at: current?.last_heartbeat_at ?? new Date().toISOString(),
        recommended_next_tools: ['vibecode_workspace_snapshot', 'vibecode_project_instructions'],
        warnings: result.structuredContent.warnings,
        blockers: (old?.blockers as unknown[]) ?? [],
        bootstrap: old,
      };
      return retag(result, TOOL_NAMES.sessionStart, data);
    },
  };
}

export function buildV1WorkspaceSnapshotTool(): McpToolDefinition {
  const legacy = buildWorkspaceStatusTool();
  return {
    name: TOOL_NAMES.workspaceSnapshot,
    title: 'Vibecode workspace snapshot',
    description: 'Compact bounded workspace overview: repo/git state, current run, CodeGraph state, and safety summary. Read-only.',
    inputSchema: WORKSPACE_SNAPSHOT_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'include', 'max_items']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.workspaceSnapshot, started, 'INVALID_ARGUMENT', unknown.message);
      const result = await legacy.handler({ ...input, arguments: {} });
      const old = result.structuredContent.data as Record<string, unknown> | undefined;
      const git = old?.git as Record<string, unknown> | undefined;
      const data = {
        repo: {
          root: input.context.repoRoot,
          branch: git?.branch ?? null,
          head: git?.head ?? null,
          dirty: git?.dirty ?? false,
        },
        agent: { agent_id: (input.arguments?.agent_id as string | undefined) ?? null },
        workspace_safety: {
          unclaimed_dirty_count: 0,
          staged_unclaimed_count: 0,
          foreign_claimed_dirty_count: 0,
          conflict_count: 0,
        },
        claims_summary: { owned: [], foreign: [], stale: [] },
        run: old?.current_run ?? null,
        codegraph: old?.codegraph ?? null,
        recommended_next_tools: [],
        warnings: result.structuredContent.warnings,
        snapshot: old,
      };
      return retag(result, TOOL_NAMES.workspaceSnapshot, data);
    },
  };
}

export function buildV1ProjectInstructionsTool(): McpToolDefinition {
  const legacy = buildProjectInstructionsTool();
  return {
    name: TOOL_NAMES.projectInstructions,
    title: 'Vibecode project instructions',
    description: 'Return relevant project instructions, repository rules, and operating constraints. Read-only.',
    inputSchema: PROJECT_INSTRUCTIONS_V1_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'task', 'max_chars', 'include_sources']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.projectInstructions, started, 'INVALID_ARGUMENT', unknown.message);
      const result = await legacy.handler({
        ...input,
        arguments: { include_docs: input.arguments?.include_sources === true },
      });
      return retag(result, TOOL_NAMES.projectInstructions);
    },
  };
}

export function buildV1RunStatusTool(): McpToolDefinition {
  const legacy = buildRunGetTool();
  return {
    name: TOOL_NAMES.runStatus,
    title: 'Vibecode run status',
    description: 'Return current/latest/specific run status and artifact availability. Read-only.',
    inputSchema: RUN_STATUS_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'run_ref', 'max_items']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.runStatus, started, 'INVALID_ARGUMENT', unknown.message);
      const result = await legacy.handler({
        ...input,
        arguments: { run_id: typeof input.arguments?.run_ref === 'string' ? input.arguments.run_ref : 'current' },
      });
      return retag(result, TOOL_NAMES.runStatus);
    },
  };
}

export function buildV1ArtifactReadTool(): McpToolDefinition {
  const runReader = buildArtifactReadTool();
  const scanReader = buildScanArtifactReadTool();
  return {
    name: TOOL_NAMES.artifactRead,
    title: 'Vibecode artifact read',
    description: 'Read allowlisted run and scan artifacts through one public API while preserving separate internal allowlists. Read-only.',
    inputSchema: ARTIFACT_READ_V1_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'run_ref', 'artifact_type', 'artifact_key', 'cursor', 'max_bytes']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.artifactRead, started, 'INVALID_ARGUMENT', unknown.message);
      const args = input.arguments ?? {};
      const artifactType = validateNonEmptyString(args.artifact_type, 'artifact_type');
      if (!artifactType.ok) return fail(input, TOOL_NAMES.artifactRead, started, 'INVALID_ARGUMENT', artifactType.message);
      if (!['run', 'scan'].includes(artifactType.value)) return fail(input, TOOL_NAMES.artifactRead, started, 'INVALID_ARGUMENT', 'artifact_type must be run or scan');
      const artifactKey = validateNonEmptyString(args.artifact_key, 'artifact_key');
      if (!artifactKey.ok) return fail(input, TOOL_NAMES.artifactRead, started, 'INVALID_ARGUMENT', artifactKey.message);
      const offset = cursorToOffset(args.cursor);
      if (Number.isNaN(offset)) return fail(input, TOOL_NAMES.artifactRead, started, 'INVALID_ARGUMENT', 'cursor must be a numeric byte offset string');
      const maxBytes = validateBoundedInteger(args.max_bytes, 'max_bytes', HARD_MAX_ARTIFACT_BYTES);
      if (!maxBytes.ok) return fail(input, TOOL_NAMES.artifactRead, started, 'INVALID_ARGUMENT', maxBytes.message);
      const reader = artifactType.value === 'scan' ? scanReader : runReader;
      const result = await reader.handler({
        ...input,
        arguments: {
          run_id: typeof args.run_ref === 'string' ? args.run_ref : 'current',
          artifact: artifactKey.value,
          ...(offset !== undefined ? { byte_offset: offset } : {}),
          ...(maxBytes.value !== undefined ? { max_bytes: maxBytes.value } : {}),
        },
      });
      const old = result.structuredContent.data as Record<string, unknown> | undefined;
      const data = {
        artifact_type: artifactType.value,
        artifact_key: artifactKey.value,
        content: old?.content,
        truncated: old?.truncated ?? old?.has_more ?? false,
        next_cursor: old?.next_byte_offset === undefined || old?.next_byte_offset === null ? undefined : String(old.next_byte_offset),
        read: old,
      };
      return retag(result, TOOL_NAMES.artifactRead, data);
    },
  };
}

export function buildV1ChangesTool(): McpToolDefinition {
  const legacy = buildGitChangesTool();
  return {
    name: TOOL_NAMES.changes,
    title: 'Vibecode changes',
    description: 'Return claim-aware workspace change classification. Read-only.',
    inputSchema: CHANGES_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'intent_id', 'include_diff_stat', 'max_items']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.changes, started, 'INVALID_ARGUMENT', unknown.message);
      const maxItems = validateBoundedInteger(input.arguments?.max_items, 'max_items', HARD_MAX_GIT_CHANGES_FILES);
      if (!maxItems.ok) return fail(input, TOOL_NAMES.changes, started, 'INVALID_ARGUMENT', maxItems.message);
      const include = validateBoolean(input.arguments?.include_diff_stat, 'include_diff_stat');
      if (!include.ok) return fail(input, TOOL_NAMES.changes, started, 'INVALID_ARGUMENT', include.message);
      const result = await legacy.handler({
        ...input,
        arguments: {
          agent_id: input.arguments?.agent_id,
          max_files: maxItems.value,
          include_diff_stat: include.value,
        },
      });
      return retag(result, TOOL_NAMES.changes);
    },
  };
}

export function buildV1CodeGraphSearchTool(): McpToolDefinition {
  const legacy = buildCodeGraphSearchTool();
  return {
    name: TOOL_NAMES.codegraphSearch,
    title: 'Vibecode CodeGraph search',
    description: 'Find indexed symbols, files, and code entities. Read-only.',
    inputSchema: CODEGRAPH_SEARCH_V1_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'query', 'kind', 'max_results']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.codegraphSearch, started, 'INVALID_ARGUMENT', unknown.message);
      return retag(await legacy.handler({
        ...input,
        arguments: { query: input.arguments?.query, maxResults: input.arguments?.max_results },
      }), TOOL_NAMES.codegraphSearch);
    },
  };
}

export function buildV1CodeGraphExploreTool(): McpToolDefinition {
  const legacy = buildCodeGraphContextTool();
  return {
    name: TOOL_NAMES.codegraphExplore,
    title: 'Vibecode CodeGraph explore',
    description: 'Explore a subsystem, flow, or architectural area through bounded CodeGraph context. Read-only.',
    inputSchema: CODEGRAPH_EXPLORE_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'topic', 'paths', 'max_items']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.codegraphExplore, started, 'INVALID_ARGUMENT', unknown.message);
      const paths = Array.isArray(input.arguments?.paths) ? ` paths: ${(input.arguments?.paths as string[]).join(', ')}` : '';
      return retag(await legacy.handler({
        ...input,
        arguments: {
          query: `${String(input.arguments?.topic ?? '')}${paths}`,
          maxNodes: input.arguments?.max_items,
        },
      }), TOOL_NAMES.codegraphExplore);
    },
  };
}

export function buildV1CodeGraphCallersTool(): McpToolDefinition {
  const legacy = buildCodeGraphCallersTool();
  return {
    name: TOOL_NAMES.codegraphCallers,
    title: 'Vibecode CodeGraph callers',
    description: 'Find who calls or depends on a symbol before changing it. Read-only.',
    inputSchema: CODEGRAPH_CALLERS_V1_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'symbol', 'path', 'max_depth', 'max_items']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.codegraphCallers, started, 'INVALID_ARGUMENT', unknown.message);
      return retag(await legacy.handler({
        ...input,
        arguments: { symbol: input.arguments?.symbol, limit: input.arguments?.max_items },
      }), TOOL_NAMES.codegraphCallers);
    },
  };
}

export function buildV1CodeGraphImpactTool(): McpToolDefinition {
  const legacy = buildCodeGraphImpactTool();
  return {
    name: TOOL_NAMES.codegraphImpact,
    title: 'Vibecode CodeGraph impact',
    description: 'Estimate impact before changing shared code, public APIs, coordination logic, or broad architecture. Read-only.',
    inputSchema: CODEGRAPH_IMPACT_V1_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'targets', 'max_depth', 'max_items']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.codegraphImpact, started, 'INVALID_ARGUMENT', unknown.message);
      const targets = input.arguments?.targets;
      if (!Array.isArray(targets) || targets.length === 0) return fail(input, TOOL_NAMES.codegraphImpact, started, 'INVALID_ARGUMENT', 'targets must be a non-empty array');
      const first = targets[0] as Record<string, unknown>;
      const inputText = typeof first.symbol === 'string' && first.symbol.trim() ? first.symbol : first.path;
      return retag(await legacy.handler({
        ...input,
        arguments: { input: inputText, limit: input.arguments?.max_depth ?? input.arguments?.max_items },
      }), TOOL_NAMES.codegraphImpact);
    },
  };
}

export function buildV1BuildStartTool(): McpToolDefinition {
  return {
    name: TOOL_NAMES.buildStart,
    title: 'Vibecode build start',
    description: 'Start build work and explicitly claim exact files. Coordination write when dry_run=false.',
    inputSchema: BUILD_START_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'task', 'paths', 'dry_run', 'intent_id']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.buildStart, started, 'INVALID_ARGUMENT', unknown.message);
      const args = input.arguments ?? {};
      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail(input, TOOL_NAMES.buildStart, started, 'INVALID_ARGUMENT', agentId.message);
      const paths = validateStringArray(args.paths, 'paths');
      if (!paths.ok) return fail(input, TOOL_NAMES.buildStart, started, 'INVALID_ARGUMENT', paths.message);
      const dryRun = validateBoolean(args.dry_run, 'dry_run');
      if (!dryRun.ok) return fail(input, TOOL_NAMES.buildStart, started, 'INVALID_ARGUMENT', dryRun.message);
      try {
        const result = dryRun.value === true
          ? (() => {
              const plan = planClaims({
                repoRoot: input.context.repoRoot,
                agent_id: agentId.value,
                paths: paths.value,
                intent: typeof args.task === 'string' ? args.task : 'Build work',
              });
              return {
                status: plan.can_claim_all ? 'ok' : 'blocked',
                intent_id: typeof args.intent_id === 'string' ? args.intent_id : null,
                created_claims: plan.claimable_paths.map((pathValue) => ({ path: pathValue })),
                blocked_paths: plan.paths.filter((pathPlan) => pathPlan.blocking),
                warnings: plan.warnings,
                plan,
              };
            })()
          : addBulkClaims({
              repoRoot: input.context.repoRoot,
              agent_id: agentId.value,
              paths: paths.value,
              intent: typeof args.task === 'string' ? args.task : 'Build work',
              intent_id: typeof args.intent_id === 'string' ? args.intent_id : undefined,
            });
        const data = {
          ok: result.status === 'ok',
          intent_id: result.intent_id,
          claimed_paths: result.created_claims.map((claim) => claim.path),
          denied_paths: result.blocked_paths.map((block) => block.path),
          warnings: result.warnings,
          blockers: result.blocked_paths,
          recommended_next_tools: ['vibecode_codegraph_explore', 'vibecode_changes'],
          result,
        };
        return formatSimpleSuccess({
          tool: TOOL_NAMES.buildStart,
          repoRoot: input.context.repoRoot,
          text: `# Vibecode build start\n\nstatus: ${result.status}\nintent_id: ${result.intent_id ?? '(none)'}`,
          data,
          warnings: result.warnings,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) return fail(input, TOOL_NAMES.buildStart, started, coordCode(err, 'CLAIMS_ADD_BULK_FAILED'), err.message);
        return fail(input, TOOL_NAMES.buildStart, started, 'CLAIMS_ADD_BULK_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildV1BuildScopeTool(): McpToolDefinition {
  return {
    name: TOOL_NAMES.buildScope,
    title: 'Vibecode build scope',
    description: 'Modify an existing build scope by adding exact paths or releasing requested clean owned paths.',
    inputSchema: BUILD_SCOPE_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'intent_id', 'add_paths', 'release_paths', 'dry_run']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.buildScope, started, 'INVALID_ARGUMENT', unknown.message);
      const args = input.arguments ?? {};
      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail(input, TOOL_NAMES.buildScope, started, 'INVALID_ARGUMENT', agentId.message);
      const intentId = validateNonEmptyString(args.intent_id, 'intent_id');
      if (!intentId.ok) return fail(input, TOOL_NAMES.buildScope, started, 'INVALID_ARGUMENT', intentId.message);
      const addPaths = args.add_paths === undefined || args.add_paths === null ? { ok: true as const, value: [] as string[] } : validateStringArray(args.add_paths, 'add_paths');
      if (!addPaths.ok) return fail(input, TOOL_NAMES.buildScope, started, 'INVALID_ARGUMENT', addPaths.message);
      const releasePaths = args.release_paths === undefined || args.release_paths === null ? { ok: true as const, value: [] as string[] } : validateStringArray(args.release_paths, 'release_paths');
      if (!releasePaths.ok) return fail(input, TOOL_NAMES.buildScope, started, 'INVALID_ARGUMENT', releasePaths.message);
      const dryRun = validateBoolean(args.dry_run, 'dry_run');
      if (!dryRun.ok) return fail(input, TOOL_NAMES.buildScope, started, 'INVALID_ARGUMENT', dryRun.message);
      try {
        const added = addPaths.value.length > 0 && dryRun.value !== true
          ? addBulkClaims({
              repoRoot: input.context.repoRoot,
              agent_id: agentId.value,
              paths: addPaths.value,
              intent_id: intentId.value,
            })
          : null;
        const released: string[] = [];
        const blocked: string[] = [];
        if (releasePaths.value.length > 0) {
          const changed = getGitChangedFiles(input.context.repoRoot);
          const dirty = new Set(changed.ok ? changed.files.map((file) => file.path) : releasePaths.value);
          const state = loadCoordinationState(input.context.repoRoot);
          const intent = state.intents.find((candidate) => candidate.intent_id === intentId.value);
          if (!intent) throw new CoordinationError('INTENT_NOT_FOUND', `No work intent found: ${intentId.value}`);
          if (intent.agent_id !== agentId.value) throw new CoordinationError('INTENT_FORBIDDEN', `Intent ${intentId.value} belongs to agent ${intent.agent_id}; only its owning agent may modify it.`);
          const releaseSet = new Set(releasePaths.value);
          for (const claim of state.claims) {
            if (claim.agent_id !== agentId.value || claim.status !== 'active') continue;
            if ((claim.metadata as Record<string, unknown> | undefined)?.intent_id !== intentId.value) continue;
            if (!releaseSet.has(claim.path)) continue;
            if (dirty.has(claim.path)) blocked.push(claim.path);
            else released.push(claim.path);
          }
          if (blocked.length === 0 && dryRun.value !== true && released.length > 0) {
            const now = new Date().toISOString();
            const releasePathSet = new Set(released);
            writeCoordinationState(input.context.repoRoot, {
              ...state,
              last_updated: now,
              claims: state.claims.map((claim) =>
                releasePathSet.has(claim.path) && claim.agent_id === agentId.value
                  ? { ...claim, status: 'released' as const, released_at: now }
                  : claim,
              ),
              agents: state.agents.map((agent) =>
                agent.agent_id === agentId.value
                  ? { ...agent, claims: agent.claims.filter((claimId) => !state.claims.some((claim) => claim.claim_id === claimId && releasePathSet.has(claim.path))) }
                  : agent,
              ),
            });
          }
        }
        const data = {
          intent_id: intentId.value,
          added_claims: added?.created_claims ?? [],
          released_claims: released,
          blocked,
          warnings: added?.warnings ?? [],
        };
        return formatSimpleSuccess({
          tool: TOOL_NAMES.buildScope,
          repoRoot: input.context.repoRoot,
          text: `# Vibecode build scope\n\nintent_id: ${intentId.value}`,
          data,
          warnings: data.warnings,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof CoordinationError) return fail(input, TOOL_NAMES.buildScope, started, coordCode(err, 'CLAIMS_ADD_BULK_FAILED'), err.message);
        return fail(input, TOOL_NAMES.buildScope, started, 'CLAIMS_ADD_BULK_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function buildV1BuildFinishTool(): McpToolDefinition {
  return {
    name: TOOL_NAMES.buildFinish,
    title: 'Vibecode build finish',
    description: 'Run final claim-aware safety checks and return the commit guard command when ready. Does not commit.',
    inputSchema: BUILD_FINISH_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'intent_id', 'release_clean_claims', 'include_commit_guard_command']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.buildFinish, started, 'INVALID_ARGUMENT', unknown.message);
      const args = input.arguments ?? {};
      const agentId = validateNonEmptyString(args.agent_id, 'agent_id');
      if (!agentId.ok) return fail(input, TOOL_NAMES.buildFinish, started, 'INVALID_ARGUMENT', agentId.message);
      const releaseClean = validateBoolean(args.release_clean_claims, 'release_clean_claims');
      if (!releaseClean.ok) return fail(input, TOOL_NAMES.buildFinish, started, 'INVALID_ARGUMENT', releaseClean.message);
      const finalize = getFinalizeCheck({ repoRoot: input.context.repoRoot, agent_id: agentId.value });
      if (!finalize.ok) return fail(input, TOOL_NAMES.buildFinish, started, 'INVALID_ARGUMENT', finalize.blocks[0]?.message ?? 'build finish failed');
      const ownedDirty = finalize.changed_files.filter((file) => file.classification === 'claimed_by_agent');
      const unclaimed = finalize.changed_files.filter((file) => file.classification === 'unclaimed');
      const foreign = finalize.changed_files.filter((file) => file.classification === 'claimed_by_other_active_agent');
      const stagedBlockers = finalize.changed_files.filter((file) => file.staged && file.classification !== 'claimed_by_agent');
      let released: unknown = null;
      if (releaseClean.value === true && typeof args.intent_id === 'string') {
        released = releaseClaimIntent({
          repoRoot: input.context.repoRoot,
          agent_id: agentId.value,
          intent_id: args.intent_id,
          dry_run: false,
        });
      }
      const commitCommand = finalize.recommended_cli_commands.find((cmd) => cmd.includes('--message')) ?? null;
      const data = {
        status: finalize.status === 'blocked'
          ? 'blocked'
          : ownedDirty.length > 0
          ? 'ready_to_commit'
          : 'no_claimed_changes',
        owned_dirty_files: ownedDirty,
        owned_clean_files: [],
        unclaimed_dirty_files: unclaimed,
        foreign_claimed_dirty_files: foreign,
        staged_blockers: stagedBlockers,
        release_eligible_claims: [],
        commit_guard: {
          allowed: finalize.status !== 'blocked' && commitCommand !== null,
          command: commitCommand,
        },
        warnings: finalize.warnings,
        blockers: finalize.blocks,
        recommended_next_tools: ['vibecode_handoff'],
        finalize,
        released,
      };
      return formatSimpleSuccess({
        tool: TOOL_NAMES.buildFinish,
        repoRoot: input.context.repoRoot,
        text: `# Vibecode build finish\n\nstatus: ${data.status}`,
        data,
        durationMs: Date.now() - started,
      });
    },
  };
}

export function buildV1HandoffTool(): McpToolDefinition {
  const prepare = buildHandoffPrepareTool();
  const guide = buildHandoffGuideTool();
  return {
    name: TOOL_NAMES.handoff,
    title: 'Vibecode handoff',
    description: 'Prepare or consume handoff guidance. Visibility only; no ownership transfer.',
    inputSchema: HANDOFF_SCHEMA,
    handler: async (input) => {
      const started = Date.now();
      const unknown = rejectUnknownKeys(input.arguments, new Set(['agent_id', 'mode', 'from_agent_id', 'for_agent_id', 'max_items']));
      if (!unknown.ok) return fail(input, TOOL_NAMES.handoff, started, 'INVALID_ARGUMENT', unknown.message);
      const mode = input.arguments?.mode;
      if (mode !== 'prepare' && mode !== 'guide') return fail(input, TOOL_NAMES.handoff, started, 'INVALID_ARGUMENT', 'mode must be prepare or guide');
      const result = mode === 'prepare'
        ? await prepare.handler({
            ...input,
            arguments: { agent_id: input.arguments?.agent_id, max_items: input.arguments?.max_items },
          })
        : await guide.handler({
            ...input,
            arguments: {
              from_agent_id: input.arguments?.from_agent_id,
              for_agent_id: input.arguments?.for_agent_id,
              max_items: input.arguments?.max_items,
            },
          });
      const old = result.structuredContent.data as Record<string, unknown> | undefined;
      return retag(result, TOOL_NAMES.handoff, {
        ownership_transferred: false,
        must_claim_explicitly: true,
        handoff: old,
      });
    },
  };
}

export function buildV1McpTools(): McpToolDefinition[] {
  return [
    buildV1SessionStartTool(),
    buildV1WorkspaceSnapshotTool(),
    buildV1ProjectInstructionsTool(),
    buildV1RunStatusTool(),
    buildV1ArtifactReadTool(),
    buildV1ChangesTool(),
    buildV1CodeGraphSearchTool(),
    buildV1CodeGraphExploreTool(),
    buildV1CodeGraphCallersTool(),
    buildV1CodeGraphImpactTool(),
    buildV1BuildStartTool(),
    buildV1BuildScopeTool(),
    buildV1BuildFinishTool(),
    buildV1HandoffTool(),
  ];
}
