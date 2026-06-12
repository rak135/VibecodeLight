import type { AgentSession, ClaimIntent, FileClaim } from '../coordination/types.js';
import type { McpUsageLogEvent } from './mcp_usage_log.js';
import { normalizeToV1ToolName } from './mcp_tool_names.js';

/**
 * Read-only activity timeline reconstruction (Cockpit v2).
 *
 * Builds a bounded, newest-first event list from sources that already exist:
 *   - the MCP tool-usage log (tool calls, attributed or honestly unattributed);
 *   - coordination state timestamps (agent registration, intent/claim
 *     creation and release).
 *
 * There is no durable coordination event journal yet, so this is an honest
 * reconstruction from persisted timestamps — events that left no timestamp
 * (e.g. heartbeats between first and last) are NOT invented. Raw file
 * contents never appear here; paths are capped to a small sample per event;
 * historical pre-v1 tool names are normalized to their v1 equivalents.
 */

export const ACTIVITY_TIMELINE_MAX_EVENTS = 100;
export const ACTIVITY_TIMELINE_MAX_PATHS = 5;

export type ActivityTimelineEventKind =
  | 'mcp_tool_call'
  | 'agent_started'
  | 'agent_activity'
  | 'claim_added'
  | 'claim_released'
  | 'build_started'
  | 'build_finished'
  | 'handoff_prepared'
  | 'workspace_safety_changed';

export type ActivityTimelineSeverity = 'info' | 'success' | 'warning' | 'blocked' | 'error';

export interface ActivityTimelineEvent {
  timestamp: string;
  kind: ActivityTimelineEventKind;
  agent_id?: string;
  agent_label?: string;
  intent_id?: string;
  tool_name?: string;
  ok?: boolean;
  status?: string;
  summary: string;
  paths?: string[];
  path_count?: number;
  severity: ActivityTimelineSeverity;
}

export interface ActivityTimelineSources {
  /** Usage-log events in chronological (file) order. */
  usageEvents: readonly McpUsageLogEvent[];
  agents: readonly AgentSession[];
  /** All claims including released ones (release timestamps feed the timeline). */
  claims: readonly FileClaim[];
  intents: readonly ClaimIntent[];
}

export interface ActivityTimelineResult {
  /** Newest-first, capped at {@link ACTIVITY_TIMELINE_MAX_EVENTS}. */
  events: ActivityTimelineEvent[];
  /** True event count before the cap. */
  total: number;
  truncated: boolean;
}

function samplePaths(paths: readonly string[]): string[] {
  return paths.slice(0, ACTIVITY_TIMELINE_MAX_PATHS);
}

function toolCallEvent(event: McpUsageLogEvent, labelById: Map<string, string>): ActivityTimelineEvent {
  const { tool_name } = normalizeToV1ToolName(event.tool_name);
  const outcome = event.ok ? 'ok' : `failed${event.error_code ? ` (${event.error_code})` : ''}`;
  const severity: ActivityTimelineSeverity = !event.ok
    ? 'error'
    : tool_name === 'vibecode_build_finish'
    ? 'success'
    : 'info';
  const out: ActivityTimelineEvent = {
    timestamp: event.timestamp,
    kind: 'mcp_tool_call',
    tool_name,
    ok: event.ok,
    summary: `${tool_name} ${outcome} ${event.duration_ms}ms`,
    severity,
  };
  if (event.agent_id !== undefined) {
    out.agent_id = event.agent_id;
    const label = labelById.get(event.agent_id);
    if (label !== undefined) out.agent_label = label;
  }
  return out;
}

function agentStartedEvent(agent: AgentSession): ActivityTimelineEvent {
  const mode = (agent.metadata as Record<string, unknown> | undefined)?.operating_mode;
  const modeText = mode === 'read_only' || mode === 'build' ? ` (${String(mode)} mode)` : '';
  return {
    timestamp: agent.started_at,
    kind: 'agent_started',
    agent_id: agent.agent_id,
    agent_label: agent.agent_name,
    summary: `agent registered${modeText}`,
    severity: 'info',
  };
}

interface ClaimGroup {
  timestamp: string;
  agent_id: string;
  paths: string[];
}

/** Group standalone (intent-less) claims sharing agent + timestamp into one event. */
function groupClaims(
  claims: readonly FileClaim[],
  pick: (claim: FileClaim) => string | null,
): ClaimGroup[] {
  const groups = new Map<string, ClaimGroup>();
  for (const claim of claims) {
    const timestamp = pick(claim);
    if (!timestamp) continue;
    const key = `${claim.agent_id}\n${timestamp}`;
    const group = groups.get(key) ?? { timestamp, agent_id: claim.agent_id, paths: [] };
    group.paths.push(claim.path);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Build the bounded activity timeline. Pure: consumes already-loaded state,
 * never reads or writes anything itself.
 */
export function buildActivityTimeline(sources: ActivityTimelineSources): ActivityTimelineResult {
  const labelById = new Map(sources.agents.map((a) => [a.agent_id, a.agent_name] as const));
  const events: ActivityTimelineEvent[] = [];

  for (const usage of sources.usageEvents) {
    events.push(toolCallEvent(usage, labelById));
  }

  for (const agent of sources.agents) {
    events.push(agentStartedEvent(agent));
  }

  for (const intent of sources.intents) {
    const base = {
      agent_id: intent.agent_id,
      ...(labelById.has(intent.agent_id) ? { agent_label: labelById.get(intent.agent_id) } : {}),
      intent_id: intent.intent_id,
      paths: samplePaths(intent.paths),
      path_count: intent.paths.length,
    };
    events.push({
      timestamp: intent.created_at,
      kind: 'claim_added',
      ...base,
      summary: `claimed ${intent.paths.length} path(s)`,
      severity: 'info',
    });
    if (intent.released_at) {
      events.push({
        timestamp: intent.released_at,
        kind: 'claim_released',
        ...base,
        summary: `released ${intent.paths.length} path(s)`,
        severity: 'success',
      });
    }
  }

  // Claims created/released outside any intent still leave timestamps.
  const intentClaimIds = new Set(sources.intents.flatMap((i) => i.claim_ids));
  const standalone = sources.claims.filter(
    (c) => !intentClaimIds.has(c.claim_id)
      && typeof (c.metadata as Record<string, unknown> | undefined)?.intent_id !== 'string',
  );
  for (const group of groupClaims(standalone, (c) => c.created_at)) {
    events.push({
      timestamp: group.timestamp,
      kind: 'claim_added',
      agent_id: group.agent_id,
      ...(labelById.has(group.agent_id) ? { agent_label: labelById.get(group.agent_id) } : {}),
      paths: samplePaths(group.paths),
      path_count: group.paths.length,
      summary: `claimed ${group.paths.length} path(s)`,
      severity: 'info',
    });
  }
  for (const group of groupClaims(standalone, (c) => c.released_at)) {
    events.push({
      timestamp: group.timestamp,
      kind: 'claim_released',
      agent_id: group.agent_id,
      ...(labelById.has(group.agent_id) ? { agent_label: labelById.get(group.agent_id) } : {}),
      paths: samplePaths(group.paths),
      path_count: group.paths.length,
      summary: `released ${group.paths.length} path(s)`,
      severity: 'success',
    });
  }

  events.sort((a, b) => {
    const at = Date.parse(a.timestamp);
    const bt = Date.parse(b.timestamp);
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });

  const total = events.length;
  const truncated = total > ACTIVITY_TIMELINE_MAX_EVENTS;
  return { events: events.slice(0, ACTIVITY_TIMELINE_MAX_EVENTS), total, truncated };
}
