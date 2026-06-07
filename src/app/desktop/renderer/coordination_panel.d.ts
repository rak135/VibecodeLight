// Type declarations for the plain-JS read-only coordination panel module.
//
// The shape mirrors the core `CoordinationOverview` DTO; it is re-declared here
// because the renderer is plain JS and must not import from core.

export interface CoordinationOverviewAgentItem {
  agent_id: string;
  name: string;
  type: string;
  status: string;
  last_heartbeat_at?: string;
}

export interface CoordinationOverviewClaimItem {
  claim_id: string;
  path: string;
  mode: string;
  status: string;
  agent_id: string;
  agent_name?: string;
}

export interface CoordinationOverviewConflictItem {
  conflict_id: string;
  conflict_type: string;
  severity: string;
  status: string;
  involved_files: string[];
  detected_at: string;
}

export interface CoordinationOverview {
  agents: {
    total: number;
    active: number;
    stale: number;
    terminated: number;
    items: CoordinationOverviewAgentItem[];
  };
  claims: {
    total: number;
    active: number;
    stale: number;
    released: number;
    items: CoordinationOverviewClaimItem[];
  };
  conflicts: {
    unresolved: number;
    recent: CoordinationOverviewConflictItem[];
  };
  evidence: {
    recent_count: number;
    warning_count: number;
    high_count: number;
    last_event_at: string | null;
  };
}

export interface CoordinationPanelModule {
  /** Pure: build the read-only panel body HTML for a coordination overview. */
  renderCoordinationOverviewHtml(overview: CoordinationOverview | null | undefined): string;
}

declare const CoordinationPanel: CoordinationPanelModule;
export default CoordinationPanel;
