import { describe, expect, test } from 'vitest';

import {
  buildAgentHandoffPacket,
  type AgentHandoffPacketBuildInput,
  type AgentHandoffPacket,
} from '../../../src/core/agent_session/handoff_packet.js';
import {
  HANDOFF_GUIDE_DO_NOT_DO,
  HANDOFF_GUIDE_MAX_ITEMS,
  HANDOFF_ONBOARDING_STATES,
  buildNextAgentHandoffGuide,
  type NextAgentHandoffGuide,
  type NextAgentHandoffGuideBuildInput,
} from '../../../src/core/agent_session/handoff_guide.js';
import type { RuntimeAwarenessChanges } from '../../../src/core/agent_session/runtime_awareness.js';
import type { AgentSession, ClaimIntent, FileClaim } from '../../../src/core/coordination/types.js';

/**
 * Phase 4B — next-agent onboarding guidance from handoff packets (pure core).
 *
 * What breaks if removed:
 *   - the guide could tell a next agent to continue while the previous agent
 *     still needs to commit/release, or while its claims are still active;
 *   - onboarding could silently become ownership transfer (auto-claim,
 *     cross-agent release, claim reuse) instead of explicit registration and
 *     explicit claims;
 *   - read_only/stale/terminated NEXT agents could receive claim/edit/commit
 *     guidance they must never act on;
 *   - safe-command recommendations could regress to unsafe or nonexistent
 *     commands (raw git, cross-agent release, force cleanup, .vibecode edits);
 *   - path lists could start implying that Vibecode selected the next agent's
 *     task scope automatically.
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
    metadata: { operating_mode: 'build', task: 'phase 4b work' },
    ...over,
  };
}

function nextAgent(over: Partial<AgentSession> = {}): AgentSession {
  return agent({
    agent_id: 'agent-b',
    agent_name: 'Agent B',
    metadata: { operating_mode: 'build', task: 'continue phase 4b' },
    ...over,
  });
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

function changes(
  countsOver: Partial<RuntimeAwarenessChanges['counts']> = {},
  over: Partial<Omit<RuntimeAwarenessChanges, 'counts'>> = {},
): RuntimeAwarenessChanges {
  const counts = {
    total: 0,
    claimed_by_agent: 0,
    claimed_by_other_agent: 0,
    unclaimed: 0,
    stale_claim_overlap: 0,
    generated_or_ignored: 0,
    staged_unclaimed: 0,
    staged_claimed_by_other_agent: 0,
    ...countsOver,
  };
  return { ok: true, dirty: counts.total > 0, counts, ...over };
}

function packet(over: Partial<AgentHandoffPacketBuildInput> = {}): AgentHandoffPacket {
  return buildAgentHandoffPacket({
    agent: agent(),
    requestedAgentId: 'agent-a',
    changes: changes(),
    ownActiveClaims: [],
    ownActiveIntents: [],
    releasableIntentsCount: 0,
    conflictTriages: [],
    staleCoordinationPresent: false,
    now: T0,
    ...over,
  });
}

function guide(over: Partial<NextAgentHandoffGuideBuildInput> = {}): NextAgentHandoffGuide {
  return buildNextAgentHandoffGuide({
    packet: packet(),
    forAgentRequested: false,
    forAgentId: null,
    forAgent: null,
    now: T0,
    ...over,
  });
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

function allCommands(g: NextAgentHandoffGuide): string {
  return [...g.previous_agent_cli_commands, ...g.next_agent_cli_commands].join(' ');
}

describe('handoff guide — previous-agent-side onboarding states', () => {
  test('ready_to_handoff + no for-agent: next_agent_not_registered, may register and plan, never continue yet', () => {
    const g = guide();
    expect(g.from_agent_id).toBe('agent-a');
    expect(g.for_agent_id).toBeNull();
    expect(g.handoff_source.handoff_state).toBe('ready_to_handoff');
    expect(g.handoff_source.handoff_ready).toBe(true);
    expect(g.onboarding.onboarding_state).toBe('next_agent_not_registered');
    expect(g.onboarding.can_continue_now).toBe(false);
    expect(g.onboarding.can_register_and_plan).toBe(true);
    expect(g.onboarding.must_claim_explicitly).toBe(true);
    expect(g.onboarding.ownership_transferred).toBe(false);
    expect(g.required_before_continue).toContain('register_next_agent');
    expect(g.next_agent_cli_commands.join(' ')).toContain('session bootstrap --register');
    expectSafeCommands(g.previous_agent_cli_commands);
    expectSafeCommands(g.next_agent_cli_commands);
  });

  test('ready_to_handoff + active build for-agent: ready_for_new_agent, explicit plan-and-claim path', () => {
    const g = guide({ forAgentRequested: true, forAgentId: 'agent-b', forAgent: nextAgent() });
    expect(g.onboarding.onboarding_state).toBe('ready_for_new_agent');
    expect(g.onboarding.can_continue_now).toBe(true);
    expect(g.onboarding.can_register_and_plan).toBe(true);
    expect(g.onboarding.ownership_transferred).toBe(false);
    expect(g.required_before_continue).toContain('plan_and_claim_explicit_files');
    const next = g.next_agent_cli_commands.join(' ');
    expect(next).toContain('session bootstrap --agent agent-b');
    expect(next).toContain('build_pre_edit');
    expect(next).toContain('claims plan --agent agent-b');
    // The next agent never releases the previous agent's work.
    expect(next).not.toContain('intent-release');
    expectSafeCommands(g.next_agent_cli_commands);
  });

  test('ready_after_release: previous_agent_ready_after_release — wait; release commands are for the FROM agent only', () => {
    const g = guide({
      packet: packet({
        ownActiveClaims: [claim()],
        ownActiveIntents: [intent()],
        releasableIntentsCount: 1,
      }),
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent(),
    });
    expect(g.onboarding.onboarding_state).toBe('previous_agent_ready_after_release');
    expect(g.onboarding.can_continue_now).toBe(false);
    expect(g.onboarding.can_register_and_plan).toBe(true);
    expect(g.required_before_continue).toContain('previous_agent_release_intents');
    const prev = g.previous_agent_cli_commands.join(' ');
    expect(prev).toContain('intent-release --agent agent-a');
    expect(prev).toContain('--dry-run');
    // The NEXT agent's commands never contain a release or a claim of the still-owned paths.
    const next = g.next_agent_cli_commands.join(' ');
    expect(next).not.toContain('intent-release');
    expect(next).not.toContain('src/alpha.ts');
    expect(g.paths_requiring_new_claim_after_release).toContain('src/alpha.ts');
    expectSafeCommands(g.previous_agent_cli_commands);
    expectSafeCommands(g.next_agent_cli_commands);
  });

  test('commit_before_handoff: previous_agent_not_ready with guard dry-run for the FROM agent', () => {
    const g = guide({
      packet: packet({
        ownActiveClaims: [claim()],
        changes: changes({ total: 1, claimed_by_agent: 1 }),
      }),
    });
    expect(g.onboarding.onboarding_state).toBe('previous_agent_not_ready');
    expect(g.onboarding.can_continue_now).toBe(false);
    expect(g.required_before_continue).toContain('previous_agent_commit_or_revert');
    const prev = g.previous_agent_cli_commands.join(' ');
    expect(prev).toContain('git changes --agent agent-a');
    expect(prev).toContain('finalize check --agent agent-a');
    expect(prev).toContain('commit guard --agent agent-a --dry-run');
    expect(g.blockers.length).toBeGreaterThan(0);
    expectSafeCommands(g.previous_agent_cli_commands);
  });

  test('isolated_commit_before_handoff also maps to previous_agent_not_ready', () => {
    const g = guide({
      packet: packet({
        ownActiveClaims: [claim()],
        changes: changes({ total: 2, claimed_by_agent: 1, unclaimed: 1 }),
      }),
    });
    expect(g.onboarding.onboarding_state).toBe('previous_agent_not_ready');
    expect(g.required_before_continue).toContain('previous_agent_commit_or_revert');
  });

  test('blocked_by_staged_files: previous_agent_not_ready, inspect staged blockers, no commit recommendation', () => {
    const g = guide({
      packet: packet({
        ownActiveClaims: [claim()],
        changes: changes({ total: 2, claimed_by_agent: 1, unclaimed: 1, staged_unclaimed: 1 }),
      }),
    });
    expect(g.onboarding.onboarding_state).toBe('previous_agent_not_ready');
    expect(g.required_before_continue).toContain('inspect_staged_blockers');
    expect(allCommands(g)).not.toContain('commit guard');
  });

  test('stale FROM agent: previous_agent_not_ready with heartbeat-then-rerun-prepare guidance', () => {
    const g = guide({ packet: packet({ agent: agent({ status: 'stale' }) }) });
    expect(g.onboarding.onboarding_state).toBe('previous_agent_not_ready');
    expect(g.required_before_continue).toContain('previous_agent_heartbeat_and_rerun_prepare');
    const prev = g.previous_agent_cli_commands.join(' ');
    expect(prev).toContain('agents heartbeat --agent agent-a');
    expect(prev).toContain('handoff prepare --agent agent-a');
  });

  test('blocked_by_conflict: conflict triage guidance, never auto-resolve', () => {
    const g = guide({
      packet: packet({
        conflictTriages: [
          { requesting_agent_id: 'agent-a', blocking_agent_id: 'agent-b', triage_status: 'still_blocking' },
        ],
      }),
    });
    expect(g.onboarding.onboarding_state).toBe('blocked_by_conflict');
    expect(g.onboarding.can_continue_now).toBe(false);
    expect(g.required_before_continue).toContain('triage_blocking_conflict');
    const all = allCommands(g);
    expect(all).toContain('conflict_resolution');
    expect(all).toContain('conflicts list');
    expect(all).not.toMatch(/conflicts resolve/);
  });

  test('read_only_report source + active build for-agent: ready_for_new_agent (the packet is a report)', () => {
    const g = guide({
      packet: packet({ agent: agent({ metadata: { operating_mode: 'read_only', task: 'review' } }) }),
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent(),
    });
    expect(g.onboarding.onboarding_state).toBe('ready_for_new_agent');
    expect(g.onboarding.can_continue_now).toBe(true);
  });
});

describe('handoff guide — terminated/missing previous agent (never a transfer)', () => {
  test('terminated FROM agent with leftover active claims: blocked_by_active_claims + housekeeping dry-run', () => {
    const g = guide({
      packet: packet({ agent: agent({ status: 'terminated' }), ownActiveClaims: [claim()] }),
    });
    expect(g.onboarding.onboarding_state).toBe('blocked_by_active_claims');
    expect(g.onboarding.can_continue_now).toBe(false);
    expect(g.onboarding.ownership_transferred).toBe(false);
    expect(g.required_before_continue).toContain('run_coordination_housekeeping_dry_run');
    const all = allCommands(g);
    expect(all).toContain('coordination_housekeeping');
    expect(all).toContain('claims reap --dry-run');
    expect(all).not.toMatch(/claims reap --json/);
    expect(g.blocked_paths).toContain('src/alpha.ts');
    // Never recommend claiming the still-claimed paths.
    expect(g.next_agent_cli_commands.join(' ')).not.toContain('src/alpha.ts');
  });

  test('terminated FROM agent, clean, stale coordination present: stale_coordination_requires_housekeeping', () => {
    const g = guide({
      packet: packet({ agent: agent({ status: 'terminated' }), staleCoordinationPresent: true }),
    });
    expect(g.onboarding.onboarding_state).toBe('stale_coordination_requires_housekeeping');
    expect(allCommands(g)).toContain('claims reap --dry-run');
  });

  test('terminated FROM agent, clean, no stale state: next agent may register fresh, with an unavailable-previous-agent warning', () => {
    const g = guide({ packet: packet({ agent: agent({ status: 'terminated' }) }) });
    expect(g.onboarding.onboarding_state).toBe('next_agent_not_registered');
    expect(g.warnings.some((w) => w.code === 'PREVIOUS_AGENT_UNAVAILABLE')).toBe(true);
    expect(g.onboarding.can_register_and_plan).toBe(true);
  });

  test('missing FROM agent behaves like terminated: no transfer, safe guidance', () => {
    const g = guide({
      packet: packet({ agent: null, requestedAgentId: 'agent-gone' }),
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent(),
    });
    expect(g.from_agent_id).toBe('agent-gone');
    expect(g.onboarding.onboarding_state).toBe('ready_for_new_agent');
    expect(g.warnings.some((w) => w.code === 'PREVIOUS_AGENT_UNAVAILABLE')).toBe(true);
    expect(g.onboarding.ownership_transferred).toBe(false);
  });

  test('terminated FROM agent with staged blockers fails closed to uncertain_state', () => {
    const g = guide({
      packet: packet({
        agent: agent({ status: 'terminated' }),
        changes: changes({ total: 1, unclaimed: 1, staged_unclaimed: 1 }),
      }),
    });
    expect(g.onboarding.onboarding_state).toBe('uncertain_state');
    expect(g.onboarding.can_continue_now).toBe(false);
  });
});

describe('handoff guide — next-agent-side onboarding states', () => {
  test('for-agent requested but missing: next_agent_not_registered with a not-found warning', () => {
    const g = guide({ forAgentRequested: true, forAgentId: 'agent-b', forAgent: null });
    expect(g.for_agent_id).toBe('agent-b');
    expect(g.next_agent.requested).toBe(true);
    expect(g.next_agent.registered).toBe(false);
    expect(g.onboarding.onboarding_state).toBe('next_agent_not_registered');
    expect(g.warnings.some((w) => w.code === 'NEXT_AGENT_NOT_FOUND')).toBe(true);
    expect(g.next_agent_cli_commands.join(' ')).toContain('session bootstrap --register');
  });

  test('read_only for-agent: next_agent_read_only — observe only, no claim/edit/commit commands', () => {
    const g = guide({
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent({ metadata: { operating_mode: 'read_only', task: 'observe' } }),
    });
    expect(g.onboarding.onboarding_state).toBe('next_agent_read_only');
    expect(g.onboarding.can_continue_now).toBe(false);
    expect(g.onboarding.can_register_and_plan).toBe(false);
    const next = g.next_agent_cli_commands.join(' ');
    expect(next).toContain('read_only_orientation');
    expect(next).not.toContain('claims plan');
    expect(next).not.toContain('claims add');
    expect(next).not.toContain('commit guard');
  });

  test('stale for-agent: next_agent_stale_or_terminated with heartbeat-first guidance', () => {
    const g = guide({
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent({ status: 'stale' }),
    });
    expect(g.onboarding.onboarding_state).toBe('next_agent_stale_or_terminated');
    expect(g.required_before_continue).toContain('heartbeat_or_reregister_next_agent');
    const next = g.next_agent_cli_commands.join(' ');
    expect(next).toContain('agents heartbeat --agent agent-b');
    expect(next).not.toContain('claims plan');
  });

  test('terminated for-agent: next_agent_stale_or_terminated with register-new guidance, never heartbeat', () => {
    const g = guide({
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent({ status: 'terminated' }),
    });
    expect(g.onboarding.onboarding_state).toBe('next_agent_stale_or_terminated');
    const next = g.next_agent_cli_commands.join(' ');
    expect(next).toContain('session bootstrap --register');
    expect(next).not.toContain('agents heartbeat');
  });

  test('same-agent resume: flagged, with session_recovery guidance instead of a cross-agent handoff', () => {
    const g = guide({
      forAgentRequested: true,
      forAgentId: 'agent-a',
      forAgent: agent(),
    });
    expect(g.onboarding.same_agent_resume).toBe(true);
    expect(g.warnings.some((w) => w.code === 'SAME_AGENT_RESUME')).toBe(true);
    expect(g.next_agent_cli_commands.join(' ')).toContain('session_recovery');
  });

  test('cross-agent guide is not flagged as same-agent resume', () => {
    const g = guide({ forAgentRequested: true, forAgentId: 'agent-b', forAgent: nextAgent() });
    expect(g.onboarding.same_agent_resume).toBe(false);
  });
});

describe('handoff guide — fail-safe and secondary notices', () => {
  test('uncertain source state: uncertain_state, inspect only', () => {
    const g = guide({
      packet: packet({ changes: { ok: false, dirty: false, counts: changes().counts } }),
    });
    expect(g.onboarding.onboarding_state).toBe('uncertain_state');
    expect(g.onboarding.can_continue_now).toBe(false);
    expect(g.onboarding.can_register_and_plan).toBe(false);
    expect(g.required_before_continue).toContain('inspect_only');
    const all = allCommands(g);
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('intent-release');
    expect(all).not.toContain('claims plan');
  });

  test('stale coordination is a secondary warning when another state is primary', () => {
    const g = guide({
      packet: packet({
        ownActiveClaims: [claim()],
        ownActiveIntents: [intent()],
        releasableIntentsCount: 1,
        staleCoordinationPresent: true,
      }),
    });
    expect(g.onboarding.onboarding_state).toBe('previous_agent_ready_after_release');
    expect(g.warnings.some((w) => w.code === 'STALE_COORDINATION_PRESENT')).toBe(true);
    expect(allCommands(g)).toContain('claims reap --dry-run');
  });

  test('unclaimed dirty shared-tree files warn the next agent without blocking a ready handoff', () => {
    const g = guide({
      packet: packet({ changes: changes({ total: 1, unclaimed: 1 }) }),
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent(),
    });
    expect(g.onboarding.onboarding_state).toBe('ready_for_new_agent');
    expect(g.warnings.some((w) => w.code === 'UNCLAIMED_DIRTY_FILES_PRESENT')).toBe(true);
  });
});

describe('handoff guide — paths, boundaries, and bounded output', () => {
  test('path lists come from the packet and never imply automatic scope selection', () => {
    const g = guide({
      packet: packet({ ownActiveClaims: [claim()], ownActiveIntents: [intent()] }),
    });
    expect(g.blocked_paths).toContain('src/alpha.ts');
    const guidance = g.path_guidance.join(' ').toLowerCase();
    expect(guidance).toContain('handoff packet');
    expect(guidance).toMatch(/explicit/);
    expect(guidance).toMatch(/vibecode (does not|never) (select|choose)/);
    expect(guidance).toMatch(/claims plan/);
  });

  test('do_not_do includes the hard prohibitions for the next agent', () => {
    const g = guide();
    expect(g.do_not_do).toEqual([...HANDOFF_GUIDE_DO_NOT_DO]);
    const all = g.do_not_do.join(' ').toLowerCase();
    expect(all).toMatch(/ownership transfer/);
    expect(all).toMatch(/claimed by the previous agent|claimed by another/);
    expect(all).toMatch(/another agent'?s intent/);
    expect(all).toMatch(/raw git|git add\/commit/);
    expect(all).toMatch(/\.vibecode/);
    expect(all).toMatch(/director(y|ies)|glob/);
    expect(all).toMatch(/claims plan/);
    expect(g.do_not_do.length).toBeLessThanOrEqual(10);
  });

  test('every onboarding state is one of the canonical states', () => {
    expect(HANDOFF_ONBOARDING_STATES).toContain('previous_agent_not_ready');
    expect(HANDOFF_ONBOARDING_STATES).toContain('previous_agent_ready_after_release');
    expect(HANDOFF_ONBOARDING_STATES).toContain('ready_for_new_agent');
    expect(HANDOFF_ONBOARDING_STATES).toContain('next_agent_not_registered');
    expect(HANDOFF_ONBOARDING_STATES).toContain('next_agent_read_only');
    expect(HANDOFF_ONBOARDING_STATES).toContain('next_agent_stale_or_terminated');
    expect(HANDOFF_ONBOARDING_STATES).toContain('blocked_by_active_claims');
    expect(HANDOFF_ONBOARDING_STATES).toContain('blocked_by_conflict');
    expect(HANDOFF_ONBOARDING_STATES).toContain('stale_coordination_requires_housekeeping');
    expect(HANDOFF_ONBOARDING_STATES).toContain('uncertain_state');
  });

  test('path samples are bounded by max_items', () => {
    const claims = Array.from({ length: 20 }, (_, i) =>
      claim({ claim_id: `claim-${i}`, path: `src/file-${i}.ts` }),
    );
    const g = guide({
      packet: packet({ ownActiveClaims: claims, maxItems: 5 }),
      maxItems: 3,
    });
    expect(g.blocked_paths.length).toBeLessThanOrEqual(3);
    expect(g.paths_truncated).toBe(true);
  });

  test('max_items above the hard cap throws', () => {
    expect(() => guide({ maxItems: HANDOFF_GUIDE_MAX_ITEMS + 1 })).toThrow(/max_items/);
  });

  test('command lists are bounded and deduped', () => {
    const g = guide({
      packet: packet({
        ownActiveClaims: [claim()],
        ownActiveIntents: [intent()],
        releasableIntentsCount: 1,
        staleCoordinationPresent: true,
      }),
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent(),
    });
    for (const list of [g.previous_agent_cli_commands, g.next_agent_cli_commands, g.safe_next_tools]) {
      expect(list.length).toBeLessThanOrEqual(12);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  test('builder is pure: input packet is not mutated', () => {
    const p = packet({ ownActiveClaims: [claim()], ownActiveIntents: [intent()] });
    const snapshot = JSON.parse(JSON.stringify(p)) as AgentHandoffPacket;
    buildNextAgentHandoffGuide({
      packet: p,
      forAgentRequested: true,
      forAgentId: 'agent-b',
      forAgent: nextAgent(),
      now: T0,
    });
    expect(p).toEqual(snapshot);
  });

  test('all commands across all representative states are safe', () => {
    const guides = [
      guide(),
      guide({ forAgentRequested: true, forAgentId: 'agent-b', forAgent: nextAgent() }),
      guide({ packet: packet({ ownActiveClaims: [claim()], ownActiveIntents: [intent()], releasableIntentsCount: 1 }) }),
      guide({ packet: packet({ ownActiveClaims: [claim()], changes: changes({ total: 1, claimed_by_agent: 1 }) }) }),
      guide({ packet: packet({ agent: agent({ status: 'terminated' }), ownActiveClaims: [claim()] }) }),
      guide({ forAgentRequested: true, forAgentId: 'agent-b', forAgent: nextAgent({ status: 'stale' }) }),
      guide({ packet: packet({ changes: { ok: false, dirty: false, counts: changes().counts } }) }),
    ];
    for (const g of guides) {
      expectSafeCommands(g.previous_agent_cli_commands);
      expectSafeCommands(g.next_agent_cli_commands);
      for (const tool of g.safe_next_tools) {
        expect(tool.startsWith('vibecode_')).toBe(true);
      }
    }
  });
});
