// Tests for the read-only Activity Cockpit panel renderer.
//
// Protected invariant: the panel renders a useful live cockpit — summary bar,
// active agents first with stale/terminated collapsed, a newest-first
// timeline, a current-claims board grouped by agent, workspace safety, and
// compact data-quality indicators — as a READ-ONLY view. It never renders
// interactive mutation controls, never blames an agent for unclaimed dirty
// files, displays "unattributed" for tool calls without an agent_id, and
// never dumps raw overview JSON.

import { describe, expect, test } from 'vitest';

import ActivityPanel from '../../../src/app/desktop/renderer/activity_panel.js';

type Overview = NonNullable<Parameters<typeof ActivityPanel.renderActivityOverviewHtml>[0]>;

function emptyOverview(): Overview {
  return {
    generated_at: '2026-06-12T10:00:00.000Z',
    repo_root: 'C:/repo',
    agents: [],
    agent_status_counts: { active: 0, stale: 0, terminated: 0, unknown: 0 },
    recent_tool_calls: [],
    claims: [],
    timeline: [],
    workspace_safety: {
      unclaimed_dirty_count: 0,
      staged_unclaimed_count: 0,
      foreign_claimed_dirty_count: 0,
      generated_or_ignored_count: 0,
      has_suspicious_unclaimed_dirty: false,
      safety_level: 'ok',
      warnings: [],
    },
    stale_coordination: {
      has_stale_state: false,
      stale_agent_count: 0,
      stale_claim_count: 0,
      stale_intent_count: 0,
      housekeeping_commands: [],
    },
    data_quality: {
      usage_log: 'ok',
      malformed_line_count: 0,
      attributed_call_count: 0,
      unattributed_call_count: 0,
      legacy_tool_name_call_count: 0,
      coordination_state: 'ok',
      stale_state_present: false,
      git_classification: 'ok',
    },
    totals: { agents: 0, claims: 0, tool_calls_in_window: 0, timeline_events: 0 },
    warnings: [],
  };
}

function agentEntry(overrides: Partial<Overview['agents'][number]> = {}): Overview['agents'][number] {
  return {
    agent_id: 'agent-a',
    name: 'Alice',
    mode: 'build',
    status: 'active',
    last_activity_at: '2026-06-12T10:00:00.000Z',
    last_mcp_tool_at: '2026-06-12T10:00:00.000Z',
    last_mcp_tool_name: 'vibecode_workspace_snapshot',
    mcp_tool_call_count: 4,
    mcp_error_count: 1,
    claimed_path_count: 2,
    dirty_claimed_path_count: 1,
    ready_state: 'ready_to_commit',
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

function timelineEvent(
  overrides: Partial<Overview['timeline'][number]> = {},
): Overview['timeline'][number] {
  return {
    timestamp: '2026-06-12T10:00:00.000Z',
    kind: 'mcp_tool_call',
    agent_id: 'agent-a',
    agent_label: 'Alice',
    tool_name: 'vibecode_changes',
    ok: true,
    summary: 'vibecode_changes ok 12ms',
    severity: 'info',
    ...overrides,
  };
}

// Interactive affordances must never appear in the read-only panel.
const CONTROL_MARKERS = /<button|<input|<select|<textarea|onclick=|contenteditable/i;
// Mutation action labels are forbidden as standalone affordances.
const MUTATION_LABELS = /<summary[^>]*>\s*(Claim|Release|Reap|Resolve|Commit|Auto-fix|Assign|Transfer)\b/i;

describe('renderActivityOverviewHtml', () => {
  test('renders the documented empty state with no controls', () => {
    const html = ActivityPanel.renderActivityOverviewHtml(emptyOverview());
    expect(html).toContain('No attributed MCP activity yet');
    expect(html).toContain('vibecode_session_start');
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('renders an only-stale-history state when no recent activity exists', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry({ agent_id: 'agent-old', name: 'Old', status: 'stale', ready_state: 'unknown', mcp_tool_call_count: 0, last_mcp_tool_name: undefined, last_mcp_tool_at: undefined })];
    overview.agent_status_counts.stale = 1;
    overview.totals.agents = 1;
    overview.stale_coordination = {
      has_stale_state: true,
      stale_agent_count: 1,
      stale_claim_count: 0,
      stale_intent_count: 0,
      housekeeping_commands: [],
    };
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('No recent attributed MCP activity');
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('renders the top summary bar with live counts', () => {
    const overview = emptyOverview();
    overview.agents = [
      agentEntry({ agent_id: 'agent-a', ready_state: 'working' }),
      agentEntry({ agent_id: 'agent-b', name: 'Bob', ready_state: 'ready_to_commit' }),
      agentEntry({ agent_id: 'agent-c', name: 'Carol', ready_state: 'blocked' }),
    ];
    overview.agent_status_counts = { active: 3, stale: 2, terminated: 1, unknown: 0 };
    overview.totals.agents = 6;
    overview.workspace_safety.unclaimed_dirty_count = 4;
    overview.recent_tool_calls = [
      { timestamp: '2026-06-12T10:05:00.000Z', agent_id: 'agent-a', tool_name: 'vibecode_changes', ok: true, duration_ms: 12 },
    ];
    overview.totals.tool_calls_in_window = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('Active');
    expect(html).toContain('Working');
    expect(html).toContain('Ready');
    expect(html).toContain('Blocked');
    expect(html).toContain('Unclaimed dirty');
    expect(html).toContain('Stale');
    expect(html).toContain('Last MCP call');
    expect(html).toContain('vibecode_changes');
  });

  test('renders active agents expanded and stale/terminated collapsed with counts', () => {
    const overview = emptyOverview();
    overview.agents = [
      agentEntry({ agent_id: 'agent-live', name: 'Live', status: 'active', ready_state: 'working' }),
      agentEntry({ agent_id: 'agent-stale', name: 'StaleOne', status: 'stale', ready_state: 'unknown' }),
      agentEntry({ agent_id: 'agent-dead', name: 'DeadOne', status: 'terminated', ready_state: 'unknown' }),
    ];
    overview.agent_status_counts = { active: 1, stale: 1, terminated: 1, unknown: 0 };
    overview.totals.agents = 3;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);

    // Active card appears before the collapsed groups.
    expect(html.indexOf('Live')).toBeGreaterThan(-1);
    expect(html.indexOf('Live')).toBeLessThan(html.indexOf('StaleOne'));
    // Stale/terminated are inside collapsed <details> (no `open` attribute).
    const detailsBlocks = html.match(/<details[^>]*>/g) ?? [];
    expect(detailsBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of detailsBlocks) expect(block).not.toContain('open');
    expect(html).toMatch(/Stale agents \(1\)/);
    expect(html).toMatch(/Terminated agents \(1\)/);
    expect(html).not.toMatch(MUTATION_LABELS);
  });

  test('renders agent cards with mode, state, last tool, intent, and claim counts', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry({
      active_intent_id: 'intent-1',
      active_intent_text: 'refactor parser pipeline',
    })];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('Alice');
    expect(html).toContain('build');
    expect(html).toContain('ready_to_commit');
    expect(html).toContain('vibecode_workspace_snapshot');
    expect(html).toContain('refactor parser pipeline');
    expect(html).toContain('claims 2');
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('renders agents with no MCP activity without a misleading calls-zero badge', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry({
      mcp_tool_call_count: 0,
      mcp_error_count: 0,
      last_mcp_tool_name: undefined,
      last_mcp_tool_at: undefined,
    })];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('no MCP calls');
    expect(html).not.toContain('calls 0');
  });

  test('renders a blocked agent with its blockers', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry({
      ready_state: 'blocked',
      blockers: [{ code: 'STAGED_FILES_BLOCK', message: '1 staged unclaimed file(s) block commit.' }],
    })];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('blocked');
    expect(html).toContain('STAGED_FILES_BLOCK');
  });

  test('renders the timeline newest-first with unattributed and error events standing out', () => {
    const overview = emptyOverview();
    overview.timeline = [
      timelineEvent({ timestamp: '2026-06-12T10:02:00.000Z', tool_name: 'vibecode_build_finish', kind: 'mcp_tool_call', summary: 'vibecode_build_finish ok 80ms', severity: 'success' }),
      timelineEvent({ timestamp: '2026-06-12T10:01:00.000Z', agent_id: undefined, agent_label: undefined, tool_name: 'vibecode_project_instructions', ok: false, summary: 'vibecode_project_instructions failed (INVALID_ARGUMENT) 3ms', severity: 'error' }),
      timelineEvent({ timestamp: '2026-06-12T10:00:00.000Z', kind: 'claim_added', tool_name: undefined, intent_id: 'intent-1', summary: 'claimed 3 path(s)', path_count: 3, paths: ['src/a.ts'] }),
    ];
    overview.totals.timeline_events = 3;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('vibecode_build_finish');
    expect(html.toLowerCase()).toContain('unattributed');
    expect(html).toContain('INVALID_ARGUMENT');
    expect(html).toContain('claimed 3 path(s)');
    expect(html.indexOf('vibecode_build_finish')).toBeLessThan(html.indexOf('claimed 3 path(s)'));
    expect(html).toMatch(/act-sev-error/);
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('renders the current claims board grouped by agent with readable age', () => {
    const overview = emptyOverview();
    overview.claims = [
      { path: 'src/app.ts', owner_agent_id: 'agent-a', intent_id: 'intent-1', status: 'dirty', age_seconds: 60 },
      { path: 'src/lib.ts', owner_agent_id: 'agent-a', intent_id: 'intent-1', status: 'clean', age_seconds: 120 },
      { path: 'src/other.ts', owner_agent_id: 'agent-b', status: 'clean' },
    ];
    overview.totals.claims = 3;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('src/app.ts');
    expect(html).toContain('intent-1');
    expect(html).toContain('dirty');
    expect(html).toContain('clean');
    expect(html).toContain('1m');
    expect(html).toContain('2m');
    // Grouped: one explicit owner header precedes both owned paths.
    expect(html).toMatch(/<div class="coord-claim-owner">agent-a<\/div>[\s\S]*src\/app\.ts[\s\S]*src\/lib\.ts/);
    expect((html.match(/coord-claim-owner">agent-a<\/div>/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<div class="coord-claim-owner">agent-b<\/div>[\s\S]*src\/other\.ts/);
  });

  test('renders workspace safety warnings with sample paths and no per-agent blame', () => {
    const overview = emptyOverview();
    overview.workspace_safety = {
      unclaimed_dirty_count: 2,
      staged_unclaimed_count: 1,
      foreign_claimed_dirty_count: 0,
      generated_or_ignored_count: 3,
      has_suspicious_unclaimed_dirty: true,
      safety_level: 'blocked',
      warnings: [{
        code: 'UNCLAIMED_DIRTY_FILES',
        message: '2 dirty file(s) are not covered by any active claim.',
        sample_paths: ['src/mystery.ts'],
      }],
    };
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('blocked');
    expect(html).toContain('src/mystery.ts');
    expect(html.toLowerCase()).not.toContain('blame');
  });

  test('renders a compact OK state when the workspace is clean', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry()];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html.toLowerCase()).toContain('workspace');
    expect(html).toMatch(/act-safety-ok/);
  });

  test('renders compact data quality indicators', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry()];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    overview.data_quality = {
      usage_log: 'truncated',
      malformed_line_count: 3,
      attributed_call_count: 12,
      unattributed_call_count: 370,
      legacy_tool_name_call_count: 5,
      coordination_state: 'ok',
      stale_state_present: true,
      git_classification: 'unavailable',
    };
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('truncated');
    expect(html).toContain('12 attributed');
    expect(html).toContain('370 unattributed');
    expect(html).toContain('3 malformed');
  });

  test('renders stale coordination housekeeping commands as text only', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry()];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    overview.stale_coordination = {
      has_stale_state: true,
      stale_agent_count: 1,
      stale_claim_count: 2,
      stale_intent_count: 1,
      housekeeping_commands: ['vibecode claims reap --dry-run --json'],
    };
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('vibecode claims reap --dry-run --json');
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('does not dump raw overview JSON or internal paths', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry()];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).not.toContain('repo_root');
    expect(html).not.toContain('"agents"');
    expect(html).not.toContain('C:/repo');
    expect(html).not.toContain('.vibecode/logs');
  });

  test('escapes hostile values in overview content', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry({ name: '<img src=x onerror=alert(1)>' })];
    overview.agent_status_counts.active = 1;
    overview.totals.agents = 1;
    overview.timeline = [timelineEvent({ summary: '<script>alert(2)</script>' })];
    overview.totals.timeline_events = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;img');
  });

  test('handles a null overview without crashing', () => {
    const html = ActivityPanel.renderActivityOverviewHtml(null);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });
});
