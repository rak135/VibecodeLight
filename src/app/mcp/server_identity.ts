import { VIBECODE_MCP_TOOL_NAMES } from './tool_registry.js';

/**
 * Phase 2D dogfood follow-up — MCP server/build identity (read-only).
 *
 * During the Phase 2D dogfood a live MCP server session was stale: it exposed
 * 41 tools and lacked `vibecode_conflict_detail`, while the current build had
 * 42. This compact identity block lets an agent detect that: the LIVE server
 * reports the identity of the build it loaded at process start, while the
 * current checkout reports the current canonical registry (CLI `vibecode mcp
 * tools`, docs). A differing `tool_count` / `server_version` means the MCP
 * server session is stale — restart/reconnect it to pick up new tools.
 *
 * Cheap by construction: constants plus the canonical tool-name list length —
 * no git, no scanner, no filesystem access, nothing per-request beyond an
 * object literal. No mismatch warning is emitted here: the server alone cannot
 * reliably know the "expected" build; it exposes the identity so the agent can
 * compare.
 */

export const VIBECODE_MCP_SERVER_IDENTITY_NAME = 'vibecode-mcp';

/** Deterministic app/package version (kept in lockstep with package.json). */
export const VIBECODE_MCP_SERVER_IDENTITY_VERSION = '0.1.0';

/** Captured once at module load — for the stdio server that is process start. */
const SERVER_STARTED_AT = new Date().toISOString();

/** Compact server identity attached to MCP-facing read-only responses. */
export interface McpServerIdentity {
  server_name: string;
  server_version: string;
  /** Number of tools in the canonical registry of THIS running build. */
  tool_count: number;
  /** ISO-8601 timestamp this build was loaded by the server process. */
  started_at: string;
  /** Absolute repo root the server is bound to. */
  repo_root: string;
}

/**
 * Build the server identity for the bound repo.
 *
 * `VIBECODE_MCP_TOOL_NAMES` is intentionally read at CALL time, not module
 * load: tool_registry → tools/workspace_info → this module is an import cycle,
 * and the registry constant is only initialized once tool_registry finishes
 * evaluating. Handlers run long after that, so the lazy read is always safe.
 */
export function buildMcpServerIdentity(repoRoot: string): McpServerIdentity {
  return {
    server_name: VIBECODE_MCP_SERVER_IDENTITY_NAME,
    server_version: VIBECODE_MCP_SERVER_IDENTITY_VERSION,
    tool_count: VIBECODE_MCP_TOOL_NAMES.length,
    started_at: SERVER_STARTED_AT,
    repo_root: repoRoot,
  };
}
