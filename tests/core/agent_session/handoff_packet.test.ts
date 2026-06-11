import { describe, expect, test } from 'vitest';

import {
  AGENT_HANDOFF_STATES,
  HANDOFF_DO_NOT_DO,
  HANDOFF_MAX_ITEMS,
  buildAgentHandoffPacket,
  type AgentHandoffPacketBuildInput,
  type AgentHandoffPacket,
} from '../../../src/core/agent_session/handoff_packet.js';
import type { RuntimeAwarenessChanges } from '../../../src/core/agent_session/runtime_awareness.js';
import type { AgentSession, ClaimIntent, FileClaim } from '../../../src/core/coordination/types.js';

/**
 * Phase 4A — read-only handoff packet (pure core).
 *
 * What breaks if removed:
 *   - the handoff packet could report handoff_ready while dirty claimed files,
 *     staged blockers, blocking conflicts, or unreleased claims still exist;
 *   - terminated/missing/stale/uncertain states could be misreported as safe
 *     to hand off, inviting another agent to edit contested files;
 *   - safe-command recommendations could regress to unsafe or nonexistent
 *     commands (raw git, cross-agent release, force cleanup, .vibecode edits);
 *   - the do_not_do boundary guidance (no ownership transfer, no cross-agent
 *     release, no commit-guard bypass) could silently disappear.
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
    metadata: { operating_mode: 'build', task: 'phase 4a work' },
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

function baseInput(over: Partial<AgentHandoffPacketBuildInput> = {}): AgentHandoffPacketBuildInput {
  return {
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
  };
}

function packet(over: Partial<AgentHandoffPacketBuildInput> = {}): AgentHandoffPacket {
  return buildAgentHandoffPacket(baseInput(over));
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

describe('handoff packet — primary states', () => {
  test('active build agent with no claims/intents and clean tree: ready_to_handoff', () => {
    const p = packet();
    expect(p.handoff.handoff_state).toBe('ready_to_handoff');
    expect(p.handoff.handoff_ready).toBe(true);
    expect(p.handoff.next_agent_may_continue).toBe(true);
    expect(p.handoff.requires_current_agent_action).toBe(false);
    expect(p.handoff.required_before_handoff).toEqual([]);
    expect(p.blockers).toEqual([]);
    expectSafeCommands(p.safe_cli_commands);
    expectSafeCommands(p.next_agent_cli_commands);
  });

  test('clean active own intent: ready_after_release with intent-release dry-run guidance', () => {
    const p = packet({
      ownActiveClaims: [claim()],
      ownActiveIntents: [intent()],
      releasableIntentsCount: 1,
    });
    expect(p.handoff.handoff_state).toBe('ready_after_release');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.handoff.next_agent_may_continue).toBe(false);
    expect(p.handoff.requires_current_agent_action).toBe(true);
    expect(p.handoff.required_before_handoff).toContain('release_own_clean_intents');
    const all = p.safe_cli_commands.join(' ');
    expect(all).toContain('intent-release');
    expect(all).toContain('--dry-run');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('active claims without intents (clean): ready_after_release recommends own claim release', () => {
    const p = packet({ ownActiveClaims: [claim()] });
    expect(p.handoff.handoff_state).toBe('ready_after_release');
    expect(p.handoff.required_before_handoff).toContain('release_own_active_claims');
    const all = p.safe_cli_commands.join(' ');
    expect(all).toContain('claims list');
    expect(all).toContain('claims release');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('dirty claimed files only: commit_before_handoff with guard dry-run guidance', () => {
    const p = packet({
      ownActiveClaims: [claim()],
      ownActiveIntents: [intent()],
      changes: changes({ total: 1, claimed_by_agent: 1 }),
    });
    expect(p.handoff.handoff_state).toBe('commit_before_handoff');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.handoff.requires_current_agent_action).toBe(true);
    expect(p.handoff.required_before_handoff).toContain('commit_or_revert_dirty_claimed_files');
    expect(p.owned_work.dirty_claimed_files_count).toBe(1);
    const all = p.safe_cli_commands.join(' ');
    expect(all).toContain('git changes');
    expect(all).toContain('finalize check');
    expect(all).toContain('commit guard');
    expect(all).toContain('--dry-run');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('dirty claimed + unrelated unclaimed dirty: isolated_commit_before_handoff with skipped-file warning', () => {
    const p = packet({
      ownActiveClaims: [claim()],
      changes: changes({ total: 2, claimed_by_agent: 1, unclaimed: 1 }),
    });
    expect(p.handoff.handoff_state).toBe('isolated_commit_before_handoff');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.handoff.required_before_handoff).toContain('commit_or_revert_dirty_claimed_files');
    expect(p.handoff.required_before_handoff).toContain('inspect_unclaimed_dirty_files');
    expect(p.warnings.some((w) => w.code === 'ISOLATED_COMMIT_LIKELY')).toBe(true);
    // Skipped unclaimed files must never be called safe or owned.
    const isolated = p.warnings.find((w) => w.code === 'ISOLATED_COMMIT_LIKELY');
    expect(isolated?.message).toMatch(/not\b.*(safe|owned)|never.*(safe|staged|committed)/i);
    expectSafeCommands(p.safe_cli_commands);
  });

  test('staged unclaimed files: blocked_by_staged_files with a blocker, no commit recommendation', () => {
    const p = packet({
      ownActiveClaims: [claim()],
      changes: changes({ total: 2, claimed_by_agent: 1, unclaimed: 1, staged_unclaimed: 1 }),
    });
    expect(p.handoff.handoff_state).toBe('blocked_by_staged_files');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.blockers.some((b) => b.code === 'STAGED_FILES_BLOCK_HANDOFF')).toBe(true);
    expect(p.handoff.required_before_handoff).toContain('inspect_and_unstage_staged_blockers');
    const all = p.safe_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('staged other-agent claimed files also block handoff', () => {
    const p = packet({
      changes: changes({ total: 1, claimed_by_other_agent: 1, staged_claimed_by_other_agent: 1 }),
    });
    expect(p.handoff.handoff_state).toBe('blocked_by_staged_files');
    expect(p.workspace.staged_other_agent_count).toBe(1);
  });

  test('still-blocking conflict involving agent: blocked_by_conflict with conflict_resolution guidance', () => {
    const p = packet({
      conflictTriages: [
        { requesting_agent_id: 'agent-a', blocking_agent_id: 'agent-b', triage_status: 'still_blocking' },
      ],
    });
    expect(p.handoff.handoff_state).toBe('blocked_by_conflict');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.handoff.required_before_handoff).toContain('triage_blocking_conflict');
    const all = p.safe_cli_commands.join(' ');
    expect(all).toContain('conflict_resolution');
    expect(all).toContain('conflicts list');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('conflict NOT involving this agent does not block handoff', () => {
    const p = packet({
      conflictTriages: [
        { requesting_agent_id: 'agent-x', blocking_agent_id: 'agent-y', triage_status: 'still_blocking' },
      ],
    });
    expect(p.handoff.handoff_state).toBe('ready_to_handoff');
    expect(p.coordination.still_blocking_conflicts_involving_agent_count).toBe(0);
  });

  test('stale agent: stale_agent_needs_heartbeat — heartbeat then re-run, never handoff on stale state', () => {
    const p = packet({ agent: agent({ status: 'stale' }) });
    expect(p.handoff.handoff_state).toBe('stale_agent_needs_heartbeat');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.handoff.required_before_handoff).toContain('heartbeat_then_rerun_handoff_prepare');
    const all = p.safe_cli_commands.join(' ');
    expect(all).toContain('agents heartbeat');
    expect(all).toContain('handoff prepare');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('terminated agent: terminated_or_missing_agent, register-new guidance, no claim transfer', () => {
    const p = packet({
      agent: agent({ status: 'terminated' }),
      ownActiveClaims: [claim()],
    });
    expect(p.handoff.handoff_state).toBe('terminated_or_missing_agent');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.handoff.requires_current_agent_action).toBe(false);
    expect(p.handoff.required_before_handoff).toContain('register_new_agent');
    expect(p.blockers.some((b) => b.code === 'AGENT_TERMINATED')).toBe(true);
    const all = p.safe_cli_commands.join(' ');
    expect(all).toContain('--register');
    expect(all).not.toContain('heartbeat');
    expect(all).not.toContain('intent-release');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('missing agent: terminated_or_missing_agent with AGENT_NOT_FOUND blocker', () => {
    const p = packet({ agent: null, requestedAgentId: 'agent-gone' });
    expect(p.agent_id).toBe('agent-gone');
    expect(p.handoff.handoff_state).toBe('terminated_or_missing_agent');
    expect(p.blockers.some((b) => b.code === 'AGENT_NOT_FOUND')).toBe(true);
    expect(p.handoff.required_before_handoff).toContain('register_new_agent');
  });

  test('read_only agent: read_only_report — handoff trivially ready, no claim/commit guidance', () => {
    const p = packet({
      agent: agent({ metadata: { operating_mode: 'read_only', task: 'review' } }),
    });
    expect(p.handoff.handoff_state).toBe('read_only_report');
    expect(p.handoff.handoff_ready).toBe(true);
    expect(p.handoff.next_agent_may_continue).toBe(true);
    const all = p.safe_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('claims add');
    expect(all).not.toContain('intent-release');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('git unavailable: uncertain_state, fail safe, inspect-only', () => {
    const p = packet({
      changes: { ok: false, dirty: false, counts: changes().counts },
    });
    expect(p.handoff.handoff_state).toBe('uncertain_state');
    expect(p.handoff.handoff_ready).toBe(false);
    expect(p.handoff.required_before_handoff).toContain('rebootstrap_and_inspect');
    expect(p.blockers.some((b) => b.code === 'GIT_UNAVAILABLE')).toBe(true);
    const all = p.safe_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('intent-release');
    expectSafeCommands(p.safe_cli_commands);
  });

  test('invalid session metadata (missing mode/task): uncertain_state', () => {
    const p = packet({ agent: agent({ metadata: {} }) });
    expect(p.handoff.handoff_state).toBe('uncertain_state');
    expect(p.handoff.handoff_ready).toBe(false);
  });
});

describe('handoff packet — readiness rules and warnings', () => {
  test('unclaimed dirty files with clean own work: warn, do not block handoff', () => {
    const p = packet({ changes: changes({ total: 1, unclaimed: 1 }) });
    expect(p.handoff.handoff_state).toBe('ready_to_handoff');
    expect(p.handoff.handoff_ready).toBe(true);
    const warning = p.warnings.find((w) => w.code === 'UNCLAIMED_DIRTY_FILES_PRESENT');
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/inspect/i);
    expect(p.workspace.unclaimed_dirty_count).toBe(1);
  });

  test('stale coordination: warning + housekeeping recommendation, never auto cleanup, does not block', () => {
    const p = packet({ staleCoordinationPresent: true });
    expect(p.handoff.handoff_state).toBe('ready_to_handoff');
    expect(p.warnings.some((w) => w.code === 'STALE_COORDINATION_PRESENT')).toBe(true);
    const all = p.safe_cli_commands.join(' ');
    expect(all).toContain('coordination_housekeeping');
    expect(all).toContain('claims reap --dry-run');
    expect(all).not.toMatch(/claims reap --json/);
    expectSafeCommands(p.safe_cli_commands);
  });

  test('released claims grant nothing: only ACTIVE own claims/intents gate readiness', () => {
    // Caller passes only active claims/intents; with none, packet is ready and
    // the do_not_do guidance pins that released claims do not authorize edits.
    const p = packet();
    expect(p.handoff.handoff_state).toBe('ready_to_handoff');
    expect(p.do_not_do.join(' ')).toMatch(/released claims/i);
  });

  test('handoff_ready is false for every state except ready_to_handoff and read_only_report', () => {
    const readyStates = new Set(['ready_to_handoff', 'read_only_report']);
    for (const state of AGENT_HANDOFF_STATES) {
      if (!readyStates.has(state)) continue;
    }
    // Spot-check the matrix through real inputs.
    expect(packet().handoff.handoff_ready).toBe(true);
    expect(packet({ ownActiveClaims: [claim()] }).handoff.handoff_ready).toBe(false);
    expect(packet({ agent: agent({ status: 'stale' }) }).handoff.handoff_ready).toBe(false);
    expect(packet({ agent: null, requestedAgentId: 'x' }).handoff.handoff_ready).toBe(false);
  });

  test('next-agent guidance always includes independent registration, never transfer', () => {
    for (const p of [
      packet(),
      packet({ ownActiveClaims: [claim()], ownActiveIntents: [intent()], releasableIntentsCount: 1 }),
      packet({ agent: agent({ status: 'terminated' }) }),
    ]) {
      const all = p.next_agent_cli_commands.join(' ');
      expect(all).toContain('session bootstrap --register');
      expect(all).toContain('build_pre_edit');
      expect(all).not.toMatch(/transfer|takeover|adopt/i);
      expectSafeCommands(p.next_agent_cli_commands);
    }
  });
});

describe('handoff packet — do_not_do boundary guidance', () => {
  test('do_not_do includes the critical prohibitions and stays bounded', () => {
    const p = packet();
    expect(p.do_not_do).toEqual([...HANDOFF_DO_NOT_DO]);
    const all = p.do_not_do.join(' ');
    expect(all).toMatch(/claimed by another active agent/i);
    expect(all).toMatch(/released claims/i);
    expect(all).toMatch(/another agent'?s intent/i);
    expect(all).toMatch(/\.vibecode/i);
    expect(all).toMatch(/commit guard/i);
    expect(all).toMatch(/skipped|unclaimed/i);
    expect(all).toMatch(/director(y|ies)|glob/i);
    expect(p.do_not_do.length).toBeLessThanOrEqual(10);
  });
});

describe('handoff packet — bounded output', () => {
  test('sample paths and intent ids are capped by max_items', () => {
    const claims = Array.from({ length: 20 }, (_, i) =>
      claim({ claim_id: `claim-${i}`, path: `src/file-${i}.ts` }),
    );
    const intents = Array.from({ length: 20 }, (_, i) =>
      intent({ intent_id: `intent-${i}`, claim_ids: [`claim-${i}`], paths: [`src/file-${i}.ts`] }),
    );
    const p = packet({ ownActiveClaims: claims, ownActiveIntents: intents, maxItems: 5 });
    expect(p.owned_work.active_claims_count).toBe(20);
    expect(p.owned_work.active_intents_count).toBe(20);
    expect(p.owned_work.sample_claimed_paths).toHaveLength(5);
    expect(p.owned_work.sample_intent_ids).toHaveLength(5);
    expect(p.owned_work.samples_truncated).toBe(true);
  });

  test('max_items above the hard cap throws', () => {
    expect(() => packet({ maxItems: HANDOFF_MAX_ITEMS + 1 })).toThrow(/max_items/);
  });

  test('task text is bounded', () => {
    const p = packet({ agent: agent({ metadata: { operating_mode: 'build', task: 'x'.repeat(500) } }) });
    expect(p.agent.task?.length).toBeLessThanOrEqual(200);
    expect(p.agent.task_truncated).toBe(true);
  });
});
