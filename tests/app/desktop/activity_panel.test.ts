// Tests for the read-only activity observability panel renderer.
//
// Protected invariant: the panel renders agents, recent MCP tool calls, claims,
// workspace safety, and the stale-coordination counts as a compact READ-ONLY
// summary. It never renders interactive mutation controls, never blames an
// agent for unclaimed dirty files, displays "unattributed" for tool calls
// without an agent_id, and never dumps raw overview JSON.

import { describe, expect, test } from 'vitest';

import ActivityPanel from '../../../src/app/desktop/renderer/activity_panel.js';

type Overview = NonNullable<Parameters<typeof ActivityPanel.renderActivityOverviewHtml>[0]>;

function emptyOverview(): Overview {
  return {
    generated_at: '2026-06-12T10:00:00.000Z',
    repo_root: 'C:/repo',
    agents: [],
    recent_tool_calls: [],
    claims: [],
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
    totals: { agents: 0, claims: 0, tool_calls_in_window: 0 },
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

// Interactive affordances must never appear in the read-only panel.
const CONTROL_MARKERS = /<button|<input|<select|<textarea|onclick=|contenteditable/i;

describe('renderActivityOverviewHtml', () => {
  test('renders a clean empty state with no controls', () => {
    const html = ActivityPanel.renderActivityOverviewHtml(emptyOverview());
    expect(html.toLowerCase()).toContain('no mcp activity');
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('renders agent cards with mode, status, ready state, and counts', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry()];
    overview.totals.agents = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('Alice');
    expect(html).toContain('build');
    expect(html).toContain('active');
    expect(html).toContain('ready_to_commit');
    expect(html).toContain('vibecode_workspace_snapshot');
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('renders a blocked badge for agents with blockers', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry({
      ready_state: 'blocked',
      blockers: [{ code: 'STAGED_FILES_BLOCK', message: '1 staged unclaimed file(s) block commit.' }],
    })];
    overview.totals.agents = 1;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('blocked');
    expect(html).toContain('STAGED_FILES_BLOCK');
  });

  test('renders the tool timeline and labels calls without agent_id as unattributed', () => {
    const overview = emptyOverview();
    overview.recent_tool_calls = [
      { timestamp: '2026-06-12T10:01:00.000Z', agent_id: 'agent-a', tool_name: 'vibecode_changes', ok: true, duration_ms: 12 },
      { timestamp: '2026-06-12T10:00:00.000Z', tool_name: 'vibecode_project_instructions', ok: false, duration_ms: 3, error_code: 'INVALID_ARGUMENT' },
    ];
    overview.totals.tool_calls_in_window = 2;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('vibecode_changes');
    expect(html).toContain('agent-a');
    expect(html.toLowerCase()).toContain('unattributed');
    expect(html).toContain('INVALID_ARGUMENT');
    expect(html).not.toMatch(CONTROL_MARKERS);
  });

  test('renders claims with owner, intent, and dirty status', () => {
    const overview = emptyOverview();
    overview.claims = [
      { path: 'src/app.ts', owner_agent_id: 'agent-a', intent_id: 'intent-1', status: 'dirty', age_seconds: 60 },
      { path: 'src/lib.ts', owner_agent_id: 'agent-b', status: 'clean' },
    ];
    overview.totals.claims = 2;
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).toContain('src/app.ts');
    expect(html).toContain('agent-a');
    expect(html).toContain('intent-1');
    expect(html).toContain('dirty');
    expect(html).toContain('clean');
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

  test('renders stale coordination counts and housekeeping commands as text only', () => {
    const overview = emptyOverview();
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
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).not.toContain('repo_root');
    expect(html).not.toContain('"agents"');
    expect(html).not.toContain('C:/repo');
    expect(html).not.toContain('.vibecode/logs');
  });

  test('escapes hostile values in overview content', () => {
    const overview = emptyOverview();
    overview.agents = [agentEntry({ name: '<img src=x onerror=alert(1)>' })];
    const html = ActivityPanel.renderActivityOverviewHtml(overview);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  test('handles a null overview without crashing', () => {
    const html = ActivityPanel.renderActivityOverviewHtml(null);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });
});
