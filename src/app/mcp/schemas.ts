/**
 * JSON Schema (Draft 2020-12 / JSON Schema 7 compatible) input schemas for the
 * VibecodeMCP read-only CodeGraph tools.
 *
 * These schemas are sent verbatim in the `tools/list` response so MCP clients
 * see the same shape on the wire. Each handler also performs minimal manual
 * validation up-front so we can return a stable `INVALID_ARGUMENT` MCP error
 * before reaching the core CodeGraph services.
 *
 * Hard rules:
 *   - tools must NOT accept a `repo` argument; the repo is bound to the
 *     server process at startup. `additionalProperties: false` enforces this
 *     at the SDK validation layer; manual validation enforces it for clients
 *     that ignore additionalProperties.
 *   - numeric bound options are positive integers only.
 */

import { AGENT_TYPES } from '../../core/coordination/types.js';
import { AGENT_OPERATING_MODES } from '../../core/agent_session/bootstrap.js';
import { SESSION_BOOTSTRAP_MAX_ITEMS } from '../../core/agent_session/bootstrap.js';
import { HANDOFF_MAX_ITEMS } from '../../core/agent_session/handoff_packet.js';
import { TEAM_STATUS_MAX_AGENTS, TEAM_STATUS_MAX_ITEMS } from '../../core/agent_session/team_status.js';
import { GIT_CHANGES_MAX_FILES } from '../../core/workspace/git_changes_summary.js';
import { HARD_MAX_ARTIFACT_CHUNK_BYTES } from '../../core/runs/artifact_pagination.js';
import { SCAN_ARTIFACT_KEYS } from '../../core/runs/scan_artifacts.js';
import { SCAN_SUMMARY_SECTIONS, SCAN_SUMMARY_MAX_ITEMS } from '../../core/runs/scan_summary.js';
import { TOOL_PROFILE_IDS } from '../../core/agent_guidance/tool_profiles.js';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  description?: string;
  enum?: readonly string[];
  /** Element schema for `type: 'array'` properties. */
  items?: JsonSchema;
}

const POSITIVE_INT: JsonSchema = {
  type: 'integer',
  minimum: 1,
};

const NON_NEGATIVE_INT: JsonSchema = {
  type: 'integer',
  minimum: 0,
};

/**
 * Hard cap for bootstrap max_items. Re-exported from core to avoid drift.
 * @deprecated Import directly from `core/agent_session/bootstrap.js` instead.
 */
export const HARD_MAX_BOOTSTRAP_ITEMS = SESSION_BOOTSTRAP_MAX_ITEMS;

/**
 * Hard cap for git_changes max_files. Re-exported from core to avoid drift.
 * @deprecated Import directly from `core/workspace/git_changes_summary.js` instead.
 */
export const HARD_MAX_GIT_CHANGES_FILES = GIT_CHANGES_MAX_FILES;

/**
 * Hard cap for artifact_read max_bytes. Re-exported from core to avoid drift.
 * @deprecated Import directly from `core/runs/artifact_pagination.js` instead.
 */
export const HARD_MAX_ARTIFACT_BYTES = HARD_MAX_ARTIFACT_CHUNK_BYTES;

/** Hard cap for generic positive integer bounds. */
export const HARD_MAX_GENERIC_ITEMS = 500;

export const STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const SEARCH_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Search query for symbols in the indexed codebase.' },
    maxResults: { ...POSITIVE_INT, description: 'Maximum number of results to return (positive integer).' },
    timeoutMs: { ...POSITIVE_INT, description: 'Timeout in milliseconds for the underlying CodeGraph call.' },
  },
  required: ['query'],
};

export const CONTEXT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Task or focus query for bounded markdown context.' },
    maxNodes: { ...POSITIVE_INT, description: 'Maximum nodes to include in the bounded context.' },
    maxCode: { ...POSITIVE_INT, description: 'Maximum code blocks to include in the bounded context.' },
    timeoutMs: { ...POSITIVE_INT, description: 'Timeout in milliseconds for the underlying CodeGraph call.' },
  },
  required: ['query'],
};

export const FILES_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { ...POSITIVE_INT, description: 'Cap on number of file entries returned.' },
    timeoutMs: { ...POSITIVE_INT, description: 'Timeout in milliseconds for the underlying CodeGraph call.' },
  },
};

export const SYMBOL_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', description: 'Exact symbol name as indexed by upstream CodeGraph.' },
    limit: { ...POSITIVE_INT, description: 'Cap on number of results to return.' },
    timeoutMs: { ...POSITIVE_INT, description: 'Timeout in milliseconds for the underlying CodeGraph call.' },
  },
  required: ['symbol'],
};

export const IMPACT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    input: { type: 'string', description: 'Symbol or path to analyze for change impact.' },
    limit: { ...POSITIVE_INT, description: 'Traversal depth (maps to upstream --depth).' },
    timeoutMs: { ...POSITIVE_INT, description: 'Timeout in milliseconds for the underlying CodeGraph call.' },
  },
  required: ['input'],
};

// ---------------------------------------------------------------------------
// Phase MCP-2: run / artifact input schemas
// ---------------------------------------------------------------------------

export const RUNS_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { ...POSITIVE_INT, description: 'Cap on number of runs to return (newest first).' },
  },
};

export const CURRENT_RUN_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const RUN_GET_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: { type: 'string', description: 'Run id, or one of the aliases "latest"/"current".' },
  },
  required: ['run_id'],
};

export const ARTIFACT_READ_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: { type: 'string', description: 'Run id, or one of the aliases "latest"/"current".' },
    artifact: {
      type: 'string',
      description: 'Allowlisted artifact name (e.g. final_prompt, context_pack, flash_output, codegraph, task-intent).',
    },
    byte_offset: {
      ...NON_NEGATIVE_INT,
      description:
        'Byte offset into the original artifact file to start reading from (default 0). For continuation, pass the previous response\'s next_byte_offset.',
    },
    max_bytes: {
      ...POSITIVE_INT,
      maximum: HARD_MAX_ARTIFACT_CHUNK_BYTES,
      description: `Cap on bytes of UTF-8 content returned for this chunk (positive integer, max ${HARD_MAX_ARTIFACT_CHUNK_BYTES}).`,
    },
  },
  required: ['run_id', 'artifact'],
};

export const CODEGRAPH_USAGE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: { type: 'string', description: 'Run id, or one of the aliases "latest"/"current". Defaults to latest.' },
  },
};

// ---------------------------------------------------------------------------
// Phase MCP-3: workspace orientation input schemas
// ---------------------------------------------------------------------------

export const WORKSPACE_INFO_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const WORKSPACE_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const MCP_GUIDANCE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const PROJECT_INSTRUCTIONS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    include_docs: {
      type: 'boolean',
      description:
        'When true, also return bounded excerpts of architecture/codegraph docs from the strict allowlist.',
    },
  },
};

// ---------------------------------------------------------------------------
// Phase Coordination-1: read-only coordination status input schema
// ---------------------------------------------------------------------------

export const COORDINATION_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const ARTIFACTS_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: {
      type: 'string',
      description: 'Run id, or one of the aliases "latest"/"current". Defaults to latest.',
    },
  },
};

// ---------------------------------------------------------------------------
// Phase Coordination-2: agent session input schemas
// ---------------------------------------------------------------------------

export const AGENT_REGISTER_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Human-friendly agent name (duplicates allowed).' },
    type: {
      type: 'string',
      enum: [...AGENT_TYPES],
      description: 'Agent type: claude | codex | hermes | opencode | custom.',
    },
    agent_mode: {
      type: 'string',
      enum: [...AGENT_OPERATING_MODES],
      description: 'Operating mode: read_only | build. Required.',
    },
    task: { type: 'string', description: 'Task/intent for the session. Required.' },
    terminal_session_id: { type: 'string', description: 'Owning terminal session id, if any.' },
    pid: { ...POSITIVE_INT, description: 'OS process id, if known (positive integer).' },
  },
  required: ['name', 'type', 'agent_mode', 'task'],
};

export const AGENT_HEARTBEAT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Id of an already-registered agent.' },
  },
  required: ['agent_id'],
};

export const AGENTS_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

export const AGENT_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Id of an already-registered agent.' },
  },
  required: ['agent_id'],
};

// ---------------------------------------------------------------------------
// Phase Coordination-3A: advisory file claim input schemas
// ---------------------------------------------------------------------------

export const CLAIM_ADD_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Id of an active registered agent.' },
    path: { type: 'string', description: 'Repository-relative path to claim.' },
    mode: {
      type: 'string',
      enum: ['exclusive', 'shared'],
      description: 'Claim compatibility mode: exclusive | shared.',
    },
  },
  required: ['agent_id', 'path'],
};

export const CLAIMS_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Optional agent id filter.' },
    include_released: { type: 'boolean', description: 'Include explicitly released claims.' },
  },
};

export const CLAIM_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Repository-relative path to inspect.' },
  },
  required: ['path'],
};

export const CLAIM_RELEASE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim_id: { type: 'string', description: 'Id of an existing advisory claim.' },
  },
  required: ['claim_id'],
};

// ---------------------------------------------------------------------------
// Phase 2A: agent-declared work scope — claim plan + explicit bulk claim
// ---------------------------------------------------------------------------

export const CLAIMS_PLAN_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Id of an active build agent.' },
    paths: {
      type: 'array',
      description: 'Explicit repository-relative paths the agent declares it wants to claim. No globs, no directory expansion — Vibecode evaluates exactly what you supply.',
      items: { type: 'string' },
    },
    intent: { type: 'string', description: 'Optional work-intent text echoed into the recommended add-bulk command.' },
  },
  required: ['agent_id', 'paths'],
};

export const CLAIMS_ADD_BULK_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Id of an active build agent.' },
    paths: {
      type: 'array',
      description: 'Explicit repository-relative paths to claim as one work scope. No globs, no expansion.',
      items: { type: 'string' },
    },
    intent: { type: 'string', description: 'Work-intent text. Required when creating a NEW intent.' },
    intent_id: { type: 'string', description: 'Existing intent id to extend (same agent only).' },
  },
  required: ['agent_id', 'paths'],
};

// ---------------------------------------------------------------------------
// Phase 2B: claim intent lifecycle — list + release
// ---------------------------------------------------------------------------

export const CLAIM_INTENTS_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Filter intents by agent id.' },
    status: {
      type: 'string',
      enum: ['active', 'released', 'all'],
      description: 'Filter by intent status: active | released | all. Default active.',
    },
    intent_id: { type: 'string', description: 'Filter to a specific intent id.' },
    max_items: { ...POSITIVE_INT, description: 'Cap on number of intents returned.' },
  },
};

export const CLAIM_INTENT_RELEASE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Id of the owning agent (same-agent only).' },
    intent_id: { type: 'string', description: 'Id of the work intent to release.' },
    dry_run: { type: 'boolean', description: 'When true, report what would happen without releasing claims.' },
  },
  required: ['agent_id', 'intent_id'],
};

// ---------------------------------------------------------------------------
// Phase Coordination-4A: read-only finalize check input schema
// ---------------------------------------------------------------------------

export const FINALIZE_CHECK_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Coordinating agent id to check the working tree against.' },
    run_id: { type: 'string', description: 'Run id whose agent_binding.json resolves the agent.' },
  },
};

// ---------------------------------------------------------------------------
// Phase Coordination-4C: watcher evidence input schemas
// ---------------------------------------------------------------------------

export const EVIDENCE_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { ...POSITIVE_INT, description: 'Return only the newest <limit> evidence events.' },
  },
};

export const EVIDENCE_SCAN_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Coordinating agent id for the scan context.' },
    run_id: { type: 'string', description: 'Run id whose agent_binding.json resolves the agent context.' },
  },
};

// ---------------------------------------------------------------------------
// Phase Coordination-4D-cleanup: conflicts + claims reap input schemas
// ---------------------------------------------------------------------------

export const CONFLICTS_LIST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['detected', 'resolved'],
      description: 'Filter by conflict status: detected | resolved.',
    },
    conflict_type: {
      type: 'string',
      enum: ['claim_denied', 'stale_claim'],
      description: 'Filter by conflict type: claim_denied | stale_claim.',
    },
  },
};

export const CONFLICT_RESOLVE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conflict_id: { type: 'string', description: 'Id of the conflict to resolve.' },
  },
  required: ['conflict_id'],
};

export const CONFLICT_DETAIL_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conflict_id: { type: 'string', description: 'Id of the conflict to inspect.' },
  },
  required: ['conflict_id'],
};

export const CLAIMS_REAP_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dry_run: { type: 'boolean', description: 'When true, report reapable claims without releasing them.' },
  },
};

// ---------------------------------------------------------------------------
// Phase 1A: session bootstrap + claim-aware git changes input schemas
// ---------------------------------------------------------------------------

export const SESSION_BOOTSTRAP_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Existing agent id to heartbeat/refresh (revives a stale/idle session).' },
    register: { type: 'boolean', description: 'Register a NEW agent (requires agent_mode + task; ignored if agent_id is set).' },
    agent_mode: {
      type: 'string',
      enum: [...AGENT_OPERATING_MODES],
      description: 'Operating mode chosen at session start: read_only | build. Required when register=true.',
    },
    agent_name: { type: 'string', description: 'Human-friendly agent name for a new registration.' },
    agent_type: {
      type: 'string',
      enum: [...AGENT_TYPES],
      description: 'Agent runtime for a new registration: claude | codex | hermes | opencode | custom (default custom).',
    },
    task: { type: 'string', description: 'Task/intent for the session. Required when register=true.' },
    terminal_session_id: { type: 'string', description: 'Owning terminal session id, if any.' },
    run_ref: { type: 'string', description: 'Run selection: current | latest (both = current pointer) | a concrete run id.' },
    max_items: { ...POSITIVE_INT, maximum: HARD_MAX_BOOTSTRAP_ITEMS, description: `Cap on per-section item lists (positive integer, max ${HARD_MAX_BOOTSTRAP_ITEMS}).` },
    include_instructions: { type: 'boolean', description: 'Include a bounded project-instruction excerpt (default true).' },
  },
};

// ---------------------------------------------------------------------------
// Phase 4A: read-only handoff packet
// ---------------------------------------------------------------------------

/**
 * Hard cap for handoff_prepare max_items. Re-exported from core to avoid drift.
 * @deprecated Import directly from `core/agent_session/handoff_packet.js` instead.
 */
export const HARD_MAX_HANDOFF_ITEMS = HANDOFF_MAX_ITEMS;

export const HANDOFF_PREPARE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Agent id to prepare the read-only handoff packet for.' },
    max_items: { ...POSITIVE_INT, maximum: HANDOFF_MAX_ITEMS, description: `Cap on sample lists in the packet (positive integer, max ${HANDOFF_MAX_ITEMS}).` },
  },
  required: ['agent_id'],
};

// ---------------------------------------------------------------------------
// Phase 4B: read-only next-agent onboarding guide
// ---------------------------------------------------------------------------

export const HANDOFF_GUIDE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from_agent_id: { type: 'string', description: 'Previous agent id whose handoff packet is consumed as onboarding guidance.' },
    for_agent_id: { type: 'string', description: 'Optional next-agent id; enables next-agent-specific onboarding checks. Never a transfer.' },
    max_items: { ...POSITIVE_INT, maximum: HANDOFF_MAX_ITEMS, description: `Cap on path sample lists in the guide (positive integer, max ${HANDOFF_MAX_ITEMS}).` },
  },
  required: ['from_agent_id'],
};

// ---------------------------------------------------------------------------
// Phase 4C: read-only team status / team overview
// ---------------------------------------------------------------------------

export const TEAM_STATUS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    max_agents: { ...POSITIVE_INT, maximum: TEAM_STATUS_MAX_AGENTS, description: `Cap on number of agents in the overview (positive integer, max ${TEAM_STATUS_MAX_AGENTS}).` },
    max_items: { ...POSITIVE_INT, maximum: TEAM_STATUS_MAX_ITEMS, description: `Cap on sample lists (positive integer, max ${TEAM_STATUS_MAX_ITEMS}).` },
  },
};

export const GIT_CHANGES_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', description: 'Active agent id; enables claim-aware classification of changed files.' },
    max_files: { ...POSITIVE_INT, maximum: HARD_MAX_GIT_CHANGES_FILES, description: `Cap on the number of changed-file entries returned (counts are unaffected, max ${HARD_MAX_GIT_CHANGES_FILES}).` },
    include_diff_stat: { type: 'boolean', description: 'Include a bounded git diff --stat (default true). Never a full diff.' },
  },
};

// ---------------------------------------------------------------------------
// Phase 1B-2: bounded scan summary + allowlisted scan artifact reads
// ---------------------------------------------------------------------------

/**
 * Hard cap for scan_summary max_items. Re-exported from core to avoid drift.
 * @deprecated Import directly from `core/runs/scan_summary.js` instead.
 */
export const HARD_MAX_SCAN_SUMMARY_ITEMS = SCAN_SUMMARY_MAX_ITEMS;

export const SCAN_SUMMARY_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: { type: 'string', description: 'Run id, or one of the aliases "latest"/"current". Defaults to current.' },
    sections: {
      type: 'array',
      description: `Optional subset of summary sections (${SCAN_SUMMARY_SECTIONS.join(', ')}). Omit for all sections.`,
      items: { type: 'string', enum: [...SCAN_SUMMARY_SECTIONS] },
    },
    max_items: {
      ...POSITIVE_INT,
      maximum: SCAN_SUMMARY_MAX_ITEMS,
      description: `Cap on per-section item lists (positive integer, max ${SCAN_SUMMARY_MAX_ITEMS}).`,
    },
  },
};

export const SCAN_ARTIFACT_READ_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    run_id: { type: 'string', description: 'Run id, or one of the aliases "latest"/"current". Defaults to current.' },
    artifact: {
      type: 'string',
      enum: [...SCAN_ARTIFACT_KEYS],
      description: `Allowlisted scan artifact key (one of: ${SCAN_ARTIFACT_KEYS.join(', ')}).`,
    },
    byte_offset: {
      ...NON_NEGATIVE_INT,
      description:
        'Byte offset into the original scan artifact file to start reading from (default 0). For continuation, pass the previous response\'s next_byte_offset.',
    },
    max_bytes: {
      ...POSITIVE_INT,
      maximum: HARD_MAX_ARTIFACT_CHUNK_BYTES,
      description: `Cap on bytes of UTF-8 content returned for this chunk (positive integer, max ${HARD_MAX_ARTIFACT_CHUNK_BYTES}).`,
    },
  },
  required: ['artifact'],
};

// ---------------------------------------------------------------------------
// Phase 1B-3: tool profiles / recommended tool sets
// ---------------------------------------------------------------------------

export const TOOL_PROFILE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    profile: {
      type: 'string',
      enum: [...TOOL_PROFILE_IDS],
      description: `Profile id to return in full (one of: ${TOOL_PROFILE_IDS.join(', ')}). Omit to list all profiles with short descriptions.`,
    },
  },
};

/** Helper for tool handlers: verify a positive integer or return undefined. */
export function validatePositiveInteger(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `invalid ${field}: expected a positive integer, got ${JSON.stringify(value)}` };
  }
  return { ok: true, value };
}

/** Helper for tool handlers: verify a non-negative integer (>= 0) or return undefined. */
export function validateNonNegativeInteger(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { ok: false, message: `invalid ${field}: expected a non-negative integer, got ${JSON.stringify(value)}` };
  }
  return { ok: true, value };
}

/** Helper for tool handlers: verify a bounded positive integer (with hard max) or return undefined. */
export function validateBoundedInteger(
  value: unknown,
  field: string,
  max: number,
): { ok: true; value?: number } | { ok: false; message: string } {
  const base = validatePositiveInteger(value, field);
  if (!base.ok) return base;
  if (base.value !== undefined && base.value > max) {
    return { ok: false, message: `invalid ${field}: value ${base.value} exceeds maximum ${max}` };
  }
  return base;
}

/** Helper for tool handlers: verify a boolean or return undefined. */
export function validateBoolean(
  value: unknown,
  field: string,
): { ok: true; value?: boolean } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'boolean') {
    return { ok: false, message: `invalid ${field}: expected a boolean, got ${JSON.stringify(value)}` };
  }
  return { ok: true, value };
}

/** Helper for tool handlers: verify a non-empty string. */
export function validateNonEmptyString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, message: `invalid ${field}: expected a non-empty string` };
  }
  return { ok: true, value };
}

/** Helper for tool handlers: verify a non-empty array of non-empty strings. */
export function validateStringArray(
  value: unknown,
  field: string,
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: `invalid ${field}: expected a non-empty array of strings` };
  }
  if (value.length === 0) {
    return { ok: false, message: `invalid ${field}: expected at least one path` };
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { ok: false, message: `invalid ${field}: every entry must be a non-empty string` };
    }
    out.push(item);
  }
  return { ok: true, value: out };
}

/** Helper for tool handlers: reject any property the schema does not allow. */
export function rejectUnknownKeys(
  args: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
  field = 'arguments',
): { ok: true } | { ok: false; message: string } {
  if (!args) return { ok: true };
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      return { ok: false, message: `unknown ${field} key: ${key}` };
    }
  }
  return { ok: true };
}
