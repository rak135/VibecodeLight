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

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  description?: string;
  enum?: readonly string[];
}

const POSITIVE_INT: JsonSchema = {
  type: 'integer',
  minimum: 1,
};

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
    max_bytes: { ...POSITIVE_INT, description: 'Cap on bytes of UTF-8 content returned.' },
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
    terminal_session_id: { type: 'string', description: 'Owning terminal session id, if any.' },
    pid: { ...POSITIVE_INT, description: 'OS process id, if known (positive integer).' },
  },
  required: ['name', 'type'],
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
