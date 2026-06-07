// Tests for the read-only coordination observability panel renderer (Phase 5A).
//
// Protected invariant: the panel renders a compact, READ-ONLY summary of the
// coordination overview (agents/claims/conflicts/evidence) with a clean empty
// state, and never renders any mutation control (no buttons, no claim release /
// conflict resolve / reap / commit / watcher start-stop affordances).

import { describe, expect, test } from 'vitest';

import CoordinationPanel from '../../../src/app/desktop/renderer/coordination_panel.js';

type Overview = NonNullable<Parameters<typeof CoordinationPanel.renderCoordinationOverviewHtml>[0]>;

function emptyOverview(): Overview {
  return {
    agents: { total: 0, active: 0, stale: 0, terminated: 0, items: [] },
    claims: { total: 0, active: 0, stale: 0, released: 0, items: [] },
    conflicts: { unresolved: 0, recent: [] },
    evidence: { recent_count: 0, warning_count: 0, high_count: 0, last_event_at: null },
  };
}

// Markup that would indicate a mutation/control affordance leaked into the
// read-only panel.
const MUTATION_MARKERS = /<button|release|resolve|reap|\bcommit\b|claim now|start watcher|stop watcher|handoff/i;

describe('renderCoordinationOverviewHtml', () => {
  test('renders a clean empty state when there is no coordination activity', () => {
    const html = CoordinationPanel.renderCoordinationOverviewHtml(emptyOverview());
    expect(html.toLowerCase()).toContain('no coordination');
    expect(html).not.toMatch(MUTATION_MARKERS);
  });

  test('renders an active agent with its name and status', () => {
    const overview = emptyOverview();
    overview.agents = {
      total: 1,
      active: 1,
      stale: 0,
      terminated: 0,
      items: [{ agent_id: 'agent-a', name: 'Alice', type: 'codex', status: 'active', last_heartbeat_at: '2026-06-07T12:00:00.000Z' }],
    };
    const html = CoordinationPanel.renderCoordinationOverviewHtml(overview);
    expect(html).toContain('Alice');
    expect(html).toContain('active');
    expect(html).toContain('codex');
    expect(html).not.toMatch(MUTATION_MARKERS);
  });

  test('renders a stale agent as a warning', () => {
    const overview = emptyOverview();
    overview.agents = {
      total: 1,
      active: 0,
      stale: 1,
      terminated: 0,
      items: [{ agent_id: 'agent-b', name: 'Bob', type: 'claude', status: 'stale', last_heartbeat_at: '2026-06-07T11:00:00.000Z' }],
    };
    const html = CoordinationPanel.renderCoordinationOverviewHtml(overview);
    expect(html).toContain('Bob');
    expect(html).toContain('stale');
    // Stale state is surfaced with a warning affordance (class), not a control.
    expect(html).toMatch(/warn/i);
    expect(html).not.toMatch(MUTATION_MARKERS);
  });

  test('renders a stale claim summary', () => {
    const overview = emptyOverview();
    overview.claims = {
      total: 1,
      active: 0,
      stale: 1,
      released: 0,
      items: [{ claim_id: 'claim-1', path: 'src/b.ts', mode: 'exclusive', status: 'stale', agent_id: 'agent-b', agent_name: 'Bob' }],
    };
    const html = CoordinationPanel.renderCoordinationOverviewHtml(overview);
    expect(html).toContain('src/b.ts');
    expect(html).toContain('stale');
    expect(html).not.toMatch(MUTATION_MARKERS);
  });

  test('renders the unresolved conflict count and recent conflicts', () => {
    const overview = emptyOverview();
    overview.conflicts = {
      unresolved: 2,
      recent: [
        { conflict_id: 'c-1', conflict_type: 'claim_denied', severity: 'high', status: 'detected', involved_files: ['src/app.ts'], detected_at: '2026-06-07T12:00:00.000Z' },
      ],
    };
    const html = CoordinationPanel.renderCoordinationOverviewHtml(overview);
    expect(html).toContain('2');
    expect(html).toContain('claim_denied');
    expect(html).toContain('src/app.ts');
    expect(html).not.toMatch(MUTATION_MARKERS);
  });

  test('renders the evidence warning/high counts', () => {
    const overview = emptyOverview();
    overview.evidence = { recent_count: 5, warning_count: 3, high_count: 1, last_event_at: '2026-06-07T12:00:00.000Z' };
    const html = CoordinationPanel.renderCoordinationOverviewHtml(overview);
    expect(html.toLowerCase()).toContain('evidence');
    expect(html).toContain('3');
    expect(html).toContain('1');
    expect(html).not.toMatch(MUTATION_MARKERS);
  });

  test('escapes HTML in agent/claim values to avoid markup injection', () => {
    const overview = emptyOverview();
    overview.agents = {
      total: 1,
      active: 1,
      stale: 0,
      terminated: 0,
      items: [{ agent_id: 'x', name: '<script>alert(1)</script>', type: 'codex', status: 'active' }],
    };
    const html = CoordinationPanel.renderCoordinationOverviewHtml(overview);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('never renders mutation controls even with rich state', () => {
    const overview: Overview = {
      agents: { total: 1, active: 0, stale: 1, terminated: 0, items: [{ agent_id: 'a', name: 'A', type: 'codex', status: 'stale' }] },
      claims: { total: 1, active: 0, stale: 1, released: 0, items: [{ claim_id: 'c', path: 'p', mode: 'exclusive', status: 'stale', agent_id: 'a', agent_name: 'A' }] },
      conflicts: { unresolved: 1, recent: [{ conflict_id: 'c1', conflict_type: 'claim_denied', severity: 'high', status: 'detected', involved_files: ['p'], detected_at: '2026-06-07T12:00:00.000Z' }] },
      evidence: { recent_count: 1, warning_count: 1, high_count: 1, last_event_at: '2026-06-07T12:00:00.000Z' },
    };
    const html = CoordinationPanel.renderCoordinationOverviewHtml(overview);
    expect(html).not.toMatch(MUTATION_MARKERS);
  });
});
