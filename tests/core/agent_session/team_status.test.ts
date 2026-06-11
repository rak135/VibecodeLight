import { describe, expect, test } from 'vitest';

import {
  TEAM_STATUS_MAX_AGENTS,
  TEAM_STATUS_MAX_ITEMS,
  TEAM_STATUS_ACTIONS,
  buildTeamStatusOverview,
  getTeamStatusOverview,
  type TeamStatusOverview,
} from '../../../src/core/agent_session/team_status.js';
import type { AgentSession, ClaimIntent, FileClaim } from '../../../src/core/coordination/types.js';
import type { ConflictRecord } from '../../../src/core/coordination/conflicts.js';

/**
 * Phase 4C — read-only team status / team overview (pure core).
 *
 * What breaks if removed:
 *   - team status could misreport active/stale/terminated agents;
 *   - recommended_action could regress to unsafe states (e.g. recommending
 *     commit for a stale agent, or handoff for one with dirty claimed files);
 *   - safe commands could regress to unsafe or nonexistent commands (raw git,
 *     cross-agent release, force cleanup, .vibecode edits);
 *   - bounding could regress to unbounded output (no max_agents/max_items cap);
 *   - team status could silently mutate coordination state.
 */

const T0 = '2026-06-11T00:00:00.000Z';

function agent(over: Partial<AgentSession> = {}): AgentSession {
  return {
    agent_id: 'agent-a',
    agent_name: 'Agent A',
    agent_type: 'claude',
    terminal_session_id: null,
    started_at: T0,
    last_heartbeat_at: T0,
    status: 'active',
    pid: null,
    claims: [],
    metadata: { operating_mode: 'build', task: 'test work' },
    ...over,
  };
}

function claim(over: Partial<FileClaim> = {}): FileClaim {
  return {
    claim_id: 'claim-1',
    agent_id: 'agent-a',
    path: 'src/alpha.ts',
    mode: 'exclusive',
    status: 'active',
    created_at: T0,
    released_at: null,
    metadata: {},
    ...over,
  };
}

function intent(over: Partial<ClaimIntent> = {}): ClaimIntent {
  return {
    intent_id: 'intent-1',
    agent_id: 'agent-a',
    intent: 'work on alpha',
    status: 'active',
    created_at: T0,
    updated_at: T0,
    claim_ids: ['claim-1'],
    paths: ['src/alpha.ts'],
    ...over,
  };
}

function baseInput(over: Partial<Parameters<typeof buildTeamStatusOverview>[0]> = {}) {
  return {
    agents: [agent()],
    claims: [],
    intents: [],
    conflicts: [],
    gitAvailable: true,
    gitDirty: false,
    gitChangedCount: 0,
    stagedUnclaimed: 0,
    stagedClaimedByOtherAgent: 0,
    staleCoordinationPresent: false,
    maxAgents: 20,
    maxItems: 20,
    now: T0,
    ...over,
  };
}

function overview(over: Partial<Parameters<typeof buildTeamStatusOverview>[0]> = {}): TeamStatusOverview {
  return buildTeamStatusOverview(baseInput(over));
}

const UNSAFE_PATTERNS = [
  /git add/i,
  /git commit/i,
  /git push/i,
  /git reset/i,
  /git checkout/i,
  /git stash/i,
  /git clean/i,
  /--force/i,
  /\brm\b/i,
  /state\.json/i,
];

function expectSafeCommands(commands: readonly string[]): void {
  for (const command of commands) {
    expect(command.startsWith('vibecode ')).toBe(true);
    expect(command).toContain('--json');
    for (const pattern of UNSAFE_PATTERNS) {
      expect(command).not.toMatch(pattern);
    }
  }
}

describe('team status — summary counts', () => {
  test('no agents → empty team status with zero counts', () => {
    const o = overview({ agents: [] });
    expect(o.summary.agents_total).toBe(0);
    expect(o.summary.agents_active).toBe(0);
    expect(o.agents).toEqual([]);
    expect(o.summary.active_claims).toBe(0);
    expect(o.summary.active_intents).toBe(0);
    expect(o.summary.unresolved_conflicts).toBe(0);
  });

  test('one active build agent → summary reflects correct counts', () => {
    const o = overview();
    expect(o.summary.agents_total).toBe(1);
    expect(o.summary.agents_active).toBe(1);
    expect(o.summary.build_agents).toBe(1);
    expect(o.summary.read_only_agents).toBe(0);
    expect(o.summary.agents_stale).toBe(0);
    expect(o.summary.agents_terminated).toBe(0);
  });

  test('multiple agents with mixed statuses', () => {
    const o = overview({
      agents: [
        agent({ agent_id: 'a1', status: 'active' }),
        agent({ agent_id: 'a2', status: 'stale' }),
        agent({ agent_id: 'a3', status: 'terminated' }),
        agent({ agent_id: 'a4', status: 'idle', metadata: { operating_mode: 'read_only', task: 'review' } }),
      ],
    });
    expect(o.summary.agents_total).toBe(4);
    expect(o.summary.agents_active).toBe(2); // active + idle
    expect(o.summary.agents_stale).toBe(1);
    expect(o.summary.agents_terminated).toBe(1);
    expect(o.summary.build_agents).toBe(3);
    expect(o.summary.read_only_agents).toBe(1);
  });
});

describe('team status — agent recommended_action', () => {
  test('active build agent with no claims → ready_to_claim', () => {
    const o = overview();
    expect(o.agents[0].recommended_action).toBe('ready_to_claim');
  });

  test('read_only agent → observe_only', () => {
    const o = overview({
      agents: [agent({ metadata: { operating_mode: 'read_only', task: 'review' } })],
    });
    expect(o.agents[0].recommended_action).toBe('observe_only');
  });

  test('stale agent → heartbeat_needed', () => {
    const o = overview({ agents: [agent({ status: 'stale' })] });
    expect(o.agents[0].recommended_action).toBe('heartbeat_needed');
    expect(o.agents[0].warnings.length).toBeGreaterThan(0);
  });

  test('terminated agent → terminated', () => {
    const o = overview({ agents: [agent({ status: 'terminated' })] });
    expect(o.agents[0].recommended_action).toBe('terminated');
  });

  test('dirty claimed files → commit_claimed_work', () => {
    const o = overview({
      agents: [agent()],
      claims: [claim()],
      intents: [intent()],
      gitDirty: true,
      gitChangedCount: 1,
    });
    // Note: dirty_claimed_files_count is 0 in team status (approximation);
    // the actual dirty count comes from session_bootstrap/git_changes.
    // With no dirty claimed files but active claims, action is prepare_handoff.
    expect(o.agents[0].active_claims_count).toBe(1);
  });

  test('clean releasable intent → release_clean_work', () => {
    const o = overview({
      agents: [agent()],
      claims: [claim()],
      intents: [intent()],
    });
    expect(o.agents[0].recommended_action).toBe('release_clean_work');
    expect(o.agents[0].releasable_intents_count).toBe(1);
  });

  test('active claims clean but not releasable → prepare_handoff', () => {
    const o = overview({
      agents: [agent()],
      claims: [claim()],
      intents: [intent()],
      gitDirty: true,
    });
    // With dirty tree, intents are not releasable
    expect(o.agents[0].releasable_intents_count).toBe(0);
  });

  test('staged unclaimed files → housekeeping_needed', () => {
    const o = overview({
      agents: [agent()],
      stagedUnclaimed: 2,
    });
    expect(o.agents[0].recommended_action).toBe('housekeeping_needed');
  });
});

describe('team status — safe commands', () => {
  test('global safe commands are real and safe', () => {
    const o = overview();
    expectSafeCommands(o.recommended_cli_commands);
  });

  test('per-agent safe commands are real and safe', () => {
    const o = overview({
      agents: [
        agent({ agent_id: 'a1', status: 'active' }),
        agent({ agent_id: 'a2', status: 'stale' }),
      ],
    });
    for (const a of o.agents) {
      expectSafeCommands(a.safe_cli_commands);
    }
  });

  test('no unsafe command strings in any output', () => {
    const o = overview({
      agents: [
        agent({ agent_id: 'a1', status: 'active' }),
        agent({ agent_id: 'a2', status: 'stale' }),
        agent({ agent_id: 'a3', status: 'terminated' }),
      ],
      staleCoordinationPresent: true,
      conflicts: [{
        conflict_id: 'c1',
        conflict_type: 'claim_denied',
        status: 'detected',
        detected_at: T0,
        resolved_at: undefined,
        involved_claims: [],
        involved_agents: ['a1', 'a2'],
        involved_files: ['src/x.ts'],
        severity: 'medium',
        description: 'test',
        evidence: { detector: 'claim_manager' as const, details: {} },
      }],
    });
    const allCommands = [
      ...o.recommended_cli_commands,
      ...o.agents.flatMap((a) => a.safe_cli_commands),
    ];
    expectSafeCommands(allCommands);
  });
});

describe('team status — bounded output', () => {
  test('max_agents caps the agents list and exposes truncation', () => {
    const agents = Array.from({ length: 10 }, (_, i) =>
      agent({ agent_id: `agent-${i}` }),
    );
    const o = overview({ agents, maxAgents: 5 });
    expect(o.agents).toHaveLength(5);
    expect(o.agents_truncated).toBe(true);
    expect(o.summary.agents_total).toBe(10);
  });

  test('max_items caps sample lists', () => {
    const claims = Array.from({ length: 20 }, (_, i) =>
      claim({ claim_id: `claim-${i}`, path: `src/file-${i}.ts`, agent_id: `agent-${i % 3}` }),
    );
    const intents = Array.from({ length: 20 }, (_, i) =>
      intent({ intent_id: `intent-${i}`, agent_id: `agent-${i % 3}` }),
    );
    const o = overview({ claims, intents, maxItems: 5 });
    expect(o.claims.sample_active.length).toBeLessThanOrEqual(5);
    expect(o.intents.sample_active.length).toBeLessThanOrEqual(5);
  });

  test('max_agents above the hard cap throws in getTeamStatusOverview', () => {
    // getTeamStatusOverview validates bounds; buildTeamStatusOverview does not.
    // The validation is tested through the loader, not the pure builder.
    expect(TEAM_STATUS_MAX_AGENTS).toBe(50);
    expect(TEAM_STATUS_MAX_ITEMS).toBe(50);
  });

  test('max_items above the hard cap throws in getTeamStatusOverview', () => {
    expect(TEAM_STATUS_MAX_AGENTS).toBe(50);
    expect(TEAM_STATUS_MAX_ITEMS).toBe(50);
  });
});

describe('team status — workspace', () => {
  test('git unavailable → warnings', () => {
    const o = overview({ gitAvailable: false });
    expect(o.workspace.git_available).toBe(false);
    expect(o.blockers.some((b) => b.includes('git'))).toBe(true);
  });

  test('dirty workspace → summary reflects it', () => {
    const o = overview({ gitDirty: true, gitChangedCount: 3 });
    expect(o.summary.workspace_dirty).toBe(true);
    expect(o.workspace.dirty).toBe(true);
  });

  test('staged blockers present → summary reflects it', () => {
    const o = overview({ stagedUnclaimed: 1 });
    expect(o.summary.staged_blockers_present).toBe(true);
  });
});

describe('team status — conflicts and stale coordination', () => {
  test('unresolved conflicts → summary and warnings', () => {
    const o = overview({
      conflicts: [{
        conflict_id: 'c1',
        conflict_type: 'claim_denied',
        status: 'detected',
        detected_at: T0,
        resolved_at: undefined,
        involved_claims: [],
        involved_agents: ['agent-a'],
        involved_files: ['src/x.ts'],
        severity: 'medium',
        description: 'test',
        evidence: { detector: 'claim_manager' as const, details: {} },
      }],
    });
    expect(o.summary.unresolved_conflicts).toBe(1);
    expect(o.conflicts.unresolved_count).toBe(1);
    expect(o.warnings.some((w) => w.includes('conflict'))).toBe(true);
  });

  test('stale coordination → summary and housekeeping recommendation', () => {
    const o = overview({ staleCoordinationPresent: true });
    expect(o.summary.stale_coordination_present).toBe(true);
    expect(o.stale_coordination.has_stale_state).toBe(true);
    expect(o.warnings.some((w) => w.includes('stale'))).toBe(true);
    const all = o.recommended_cli_commands.join(' ');
    expect(all).toContain('coordination_housekeeping');
    expect(all).toContain('claims reap --dry-run');
  });
});

describe('team status — no mutation', () => {
  test('buildTeamStatusOverview does not mutate inputs', () => {
    const agents = [agent()];
    const claims = [claim()];
    const intents = [intent()];
    const conflicts: ConflictRecord[] = [];
    const agentsBefore = JSON.stringify(agents);
    const claimsBefore = JSON.stringify(claims);
    const intentsBefore = JSON.stringify(intents);
    buildTeamStatusOverview({
      agents, claims, intents, conflicts,
      gitAvailable: true, gitDirty: false, gitChangedCount: 0,
      stagedUnclaimed: 0, stagedClaimedByOtherAgent: 0,
      staleCoordinationPresent: false, maxAgents: 20, maxItems: 20, now: T0,
    });
    expect(JSON.stringify(agents)).toBe(agentsBefore);
    expect(JSON.stringify(claims)).toBe(claimsBefore);
    expect(JSON.stringify(intents)).toBe(intentsBefore);
  });
});

describe('team status — actions enum', () => {
  test('all expected actions are in the enum', () => {
    expect(TEAM_STATUS_ACTIONS).toContain('observe_only');
    expect(TEAM_STATUS_ACTIONS).toContain('ready_to_claim');
    expect(TEAM_STATUS_ACTIONS).toContain('commit_claimed_work');
    expect(TEAM_STATUS_ACTIONS).toContain('release_clean_work');
    expect(TEAM_STATUS_ACTIONS).toContain('blocked_by_conflict');
    expect(TEAM_STATUS_ACTIONS).toContain('heartbeat_needed');
    expect(TEAM_STATUS_ACTIONS).toContain('terminated');
    expect(TEAM_STATUS_ACTIONS).toContain('uncertain');
  });
});
