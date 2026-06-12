// Type declarations for the plain-JS read-only activity panel module.
//
// The shape mirrors the core `ActivityObservabilityOverview` DTO; it is
// re-declared here because the renderer is plain JS and must not import from
// core.

export interface ActivityOverviewNotice {
  code: string;
  message: string;
}

export interface ActivityOverviewAgent {
  agent_id: string;
  name?: string;
  mode?: 'read_only' | 'build';
  status: 'active' | 'stale' | 'terminated' | 'unknown';
  last_activity_at?: string;
  last_mcp_tool_at?: string;
  last_mcp_tool_name?: string;
  mcp_tool_call_count: number;
  mcp_error_count: number;
  claimed_path_count: number;
  dirty_claimed_path_count: number;
  active_intent_id?: string;
  active_intent_text?: string;
  ready_state:
    | 'read_only'
    | 'ready_to_claim'
    | 'working'
    | 'ready_to_commit'
    | 'blocked'
    | 'ready_to_release'
    | 'ready_for_handoff'
    | 'unknown';
  blockers: ActivityOverviewNotice[];
  warnings: ActivityOverviewNotice[];
}

export interface ActivityOverviewToolCall {
  timestamp: string;
  agent_id?: string;
  tool_name: string;
  ok: boolean;
  duration_ms: number;
  error_code?: string;
}

export interface ActivityOverviewClaim {
  path: string;
  owner_agent_id: string;
  intent_id?: string;
  status: 'clean' | 'dirty' | 'stale' | 'unknown';
  age_seconds?: number;
}

export interface ActivityOverviewSafetyWarning extends ActivityOverviewNotice {
  sample_paths?: string[];
}

export interface ActivityOverviewWorkspaceSafety {
  unclaimed_dirty_count: number;
  staged_unclaimed_count: number;
  foreign_claimed_dirty_count: number;
  generated_or_ignored_count: number;
  has_suspicious_unclaimed_dirty: boolean;
  safety_level: 'ok' | 'warning' | 'blocked';
  warnings: ActivityOverviewSafetyWarning[];
}

export interface ActivityOverviewStaleCoordination {
  has_stale_state: boolean;
  stale_agent_count: number;
  stale_claim_count: number;
  stale_intent_count: number;
  housekeeping_commands: string[];
}

export interface ActivityAgentStatusCounts {
  active: number;
  stale: number;
  terminated: number;
  unknown: number;
}

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

export interface ActivityOverviewDataQuality {
  usage_log: 'ok' | 'missing' | 'truncated';
  malformed_line_count: number;
  attributed_call_count: number;
  unattributed_call_count: number;
  legacy_tool_name_call_count: number;
  coordination_state: 'ok' | 'unavailable';
  stale_state_present: boolean;
  git_classification: 'ok' | 'unavailable';
}

export interface ActivityObservabilityOverview {
  generated_at: string;
  repo_root: string;
  agents: ActivityOverviewAgent[];
  agent_status_counts: ActivityAgentStatusCounts;
  recent_tool_calls: ActivityOverviewToolCall[];
  claims: ActivityOverviewClaim[];
  timeline: ActivityTimelineEvent[];
  workspace_safety: ActivityOverviewWorkspaceSafety;
  stale_coordination: ActivityOverviewStaleCoordination;
  data_quality: ActivityOverviewDataQuality;
  totals: {
    agents: number;
    claims: number;
    tool_calls_in_window: number;
    timeline_events: number;
  };
  warnings: ActivityOverviewNotice[];
}

export interface ActivityPanelModule {
  /** Pure: build the read-only panel body HTML for an activity overview. */
  renderActivityOverviewHtml(overview: ActivityObservabilityOverview | null | undefined): string;
}

declare const ActivityPanel: ActivityPanelModule;
export default ActivityPanel;
