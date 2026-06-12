import {
  getAgentOperatingMode,
  type AgentOperatingMode,
} from '../../core/coordination/agent_operating_mode.js';
import { heartbeatAgentDetailed } from '../../core/coordination/agents.js';
import { CoordinationError } from '../../core/coordination/errors.js';
import type { McpToolFormattedResult } from './format.js';

/**
 * Activity attribution for VibecodeMCP v1 tool usage events.
 *
 * Honesty rules:
 *   - an event is attributed ONLY from explicit signals: the `agent_id` tool
 *     argument, or the resolved agent of a `vibecode_session_start` result —
 *     never inferred, never fake-attributed;
 *   - the input summary is bounded shape metadata (flags + counts); raw paths,
 *     tasks, queries, and file contents are never recorded here;
 *   - the activity update reuses the existing internal heartbeat state and is
 *     best-effort: unknown/terminated agents are skipped (a terminated agent is
 *     never revived) and a failed update can never fail the tool call.
 */

export interface McpToolCallAttribution {
  agent_id?: string;
  /** Session identity; the v1 contract treats session_id == agent_id. */
  session_id?: string;
}

/** Bounded attribution flags merged into the usage-event input summary. */
export interface McpAttributionInputSummary {
  has_agent_id: boolean;
  has_intent_id: boolean;
  path_count?: number;
  artifact_type?: 'run' | 'scan';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Resolve which agent a v1 tool call belongs to. `vibecode_session_start` may
 * register a brand-new agent, so its event prefers the resolved agent id from
 * the structured result over the (possibly absent) `agent_id` argument.
 */
export function resolveToolCallAttribution(args: {
  toolName: string;
  toolArguments: Record<string, unknown> | undefined;
  result?: McpToolFormattedResult;
}): McpToolCallAttribution {
  let agentId = nonEmptyString(args.toolArguments?.agent_id);
  if (args.toolName === 'vibecode_session_start' && args.result && !args.result.isError) {
    const data = args.result.structuredContent.data as Record<string, unknown> | undefined;
    agentId = nonEmptyString(data?.agent_id) ?? agentId;
  }
  if (!agentId) return {};
  return { agent_id: agentId, session_id: agentId };
}

/** Build the bounded attribution flags for one tool call's input summary. */
export function buildAttributionInputSummary(
  toolArguments: Record<string, unknown> | undefined,
): McpAttributionInputSummary {
  const summary: McpAttributionInputSummary = {
    has_agent_id: nonEmptyString(toolArguments?.agent_id) !== undefined,
    has_intent_id: nonEmptyString(toolArguments?.intent_id) !== undefined,
  };
  let pathCount: number | undefined;
  if (Array.isArray(toolArguments?.paths)) {
    pathCount = toolArguments.paths.length;
  } else if (Array.isArray(toolArguments?.add_paths) || Array.isArray(toolArguments?.release_paths)) {
    pathCount = (Array.isArray(toolArguments?.add_paths) ? toolArguments.add_paths.length : 0)
      + (Array.isArray(toolArguments?.release_paths) ? toolArguments.release_paths.length : 0);
  } else if (Array.isArray(toolArguments?.targets)) {
    pathCount = toolArguments.targets.length;
  }
  if (pathCount !== undefined) summary.path_count = pathCount;
  const artifactType = toolArguments?.artifact_type;
  if (artifactType === 'run' || artifactType === 'scan') summary.artifact_type = artifactType;
  return summary;
}

export interface AgentActivityUpdateResult {
  updated: boolean;
  agent_mode?: AgentOperatingMode;
  /** Bounded reason code when the update was skipped (no message text). */
  skipped_code?: string;
}

/**
 * Record real MCP activity for an attributed agent by reusing the existing
 * internal heartbeat mutation (`last_heartbeat_at` + lifecycle status only —
 * claims/intents are never touched). Never throws:
 *   - unknown agent → skipped (`AGENT_NOT_FOUND`), the event stays attributed;
 *   - terminated agent → skipped (`AGENT_TERMINATED`), never revived.
 */
export function recordAttributedAgentActivity(
  repoRoot: string,
  agentId: string,
): AgentActivityUpdateResult {
  try {
    const detail = heartbeatAgentDetailed(repoRoot, agentId);
    return { updated: true, agent_mode: getAgentOperatingMode(detail.agent) ?? undefined };
  } catch (err) {
    return {
      updated: false,
      skipped_code: err instanceof CoordinationError ? err.code : 'ACTIVITY_UPDATE_FAILED',
    };
  }
}
