import { describe, expect, test } from 'vitest';

import {
  AGENT_RESUME_STATES,
  getAgentRecoveryGuidance,
  RECOVERY_MAX_RECOMMENDATIONS,
  type AgentRecoveryGuidance,
} from '../../../src/core/agent_session/recovery_guidance.js';
import {
  getAgentRuntimeAwareness,
  RUNTIME_HEARTBEAT_RECOMMEND_AFTER_MS,
  type AgentRuntimeAwarenessInput,
  type RuntimeAwarenessChanges,
} from '../../../src/core/agent_session/runtime_awareness.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import type { AgentSession } from '../../../src/core/coordination/types.js';

/**
 * Phase 3C — session continuity / safe resume guidance (pure core).
 *
 * What breaks if removed:
 *   - a resuming agent could be told to continue/commit/release in a state
 *     where that is unsafe (terminated agent, staged unclaimed files, released
 *     claims, unknown git state);
 *   - the single primary `resume_state` could drift from the real finalize /
 *     commit-guard / heartbeat policies it mirrors;
 *   - recovery recommendations could regress to unsafe or nonexistent commands
 *     (raw git, cross-agent release, force cleanup, `.vibecode` editing).
 */

const T0 = '2026-01-01T00:00:00.000Z';

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
    metadata: { operating_mode: 'build', task: 'phase 3c work' },
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
  const nonGenerated = counts.total - counts.generated_or_ignored;
  return { ok: true, dirty: nonGenerated > 0 || counts.total > 0, counts, ...over };
}

function baseInput(over: Partial<AgentRuntimeAwarenessInput> = {}): AgentRuntimeAwarenessInput {
  return {
    agent: agent(),
    requestedAgentId: 'agent-a',
    changes: changes(),
    activeIntentsCount: 0,
    releasableIntentsCount: 0,
    activeClaimsCount: 0,
    conflictTriages: [],
    staleCoordinationPresent: false,
    now: T0,
    ...over,
  };
}

/** Build the recovery section through the real runtime-awareness wiring. */
function recovery(over: Partial<AgentRuntimeAwarenessInput> = {}): AgentRecoveryGuidance {
  return getAgentRuntimeAwareness(baseInput(over)).recovery;
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

describe('recovery guidance — lifecycle states', () => {
  test('not registered (no agent requested): not_registered, register guidance, no old-claim reuse', () => {
    const r = recovery({ agent: null, requestedAgentId: null });
    expect(r.resume_state).toBe('not_registered');
    expect(r.confidence).toBe('high');
    expect(r.can_continue_existing_agent).toBe(false);
    expect(r.requires_new_agent).toBe(true);
    expect(r.recommended_resume_action).toBe('register_new_agent');
    expect(r.recommended_cli_commands.some((c) => c.includes('--register'))).toBe(true);
    const all = r.recommended_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('intent-release');
    expect(all).not.toContain('claims add');
    expectSafeCommands(r.recommended_cli_commands);
  });

  test('missing agent (requested id not found): not_registered with AGENT_NOT_FOUND blocker', () => {
    const r = recovery({ agent: null, requestedAgentId: 'agent-gone' });
    expect(r.resume_state).toBe('not_registered');
    expect(r.requires_new_agent).toBe(true);
    expect(r.can_continue_existing_agent).toBe(false);
    expect(r.blockers.some((b) => b.code === 'AGENT_NOT_FOUND')).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('--register'))).toBe(true);
  });

  test('terminated agent: terminated, blocked, new registration required, never heartbeat/reuse', () => {
    const r = recovery({
      agent: agent({ status: 'terminated' }),
      changes: changes({ total: 1, claimed_by_agent: 1 }),
      activeClaimsCount: 1,
    });
    expect(r.resume_state).toBe('terminated');
    expect(r.can_continue_existing_agent).toBe(false);
    expect(r.requires_new_agent).toBe(true);
    expect(r.requires_heartbeat).toBe(false);
    expect(r.blockers.some((b) => b.code === 'AGENT_TERMINATED')).toBe(true);
    expect(r.recommended_resume_action).toBe('register_new_agent');
    const all = r.recommended_cli_commands.join(' ');
    expect(all).toContain('--register');
    expect(all).not.toContain('heartbeat');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('claims add');
    expect(r.summary.toLowerCase()).toContain('new agent');
  });

  test('stale agent: stale_needs_heartbeat with heartbeat-then-rebootstrap guidance only', () => {
    const r = recovery({
      agent: agent({ status: 'stale' }),
      now: new Date(Date.parse(T0) + HEARTBEAT_TTL_MS * 2).toISOString(),
      changes: changes({ total: 1, claimed_by_agent: 1 }),
      activeClaimsCount: 1,
    });
    expect(r.resume_state).toBe('stale_needs_heartbeat');
    expect(r.can_continue_existing_agent).toBe(true);
    expect(r.requires_new_agent).toBe(false);
    expect(r.requires_heartbeat).toBe(true);
    expect(r.requires_rebootstrap).toBe(true);
    expect(r.recommended_resume_action).toBe('heartbeat_then_rebootstrap');
    expect(
      r.recommended_cli_commands.some((c) => c.includes('agents heartbeat --agent agent-a')),
    ).toBe(true);
    expect(
      r.recommended_cli_commands.some((c) => c.includes('session bootstrap --agent agent-a')),
    ).toBe(true);
    const all = r.recommended_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('claims plan');
    expect(all).not.toContain('intent-release');
  });

  test('read_only agent: read_only_observe_only with no claim/edit/commit guidance', () => {
    const r = recovery({
      agent: agent({ metadata: { operating_mode: 'read_only', task: 'review' } }),
      changes: changes({ total: 2, unclaimed: 2 }),
    });
    expect(r.resume_state).toBe('read_only_observe_only');
    expect(r.recommended_resume_action).toBe('observe_read_only');
    const all = r.recommended_cli_commands.join(' ');
    expect(all).toContain('read_only_orientation');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('claims plan');
    expect(all).not.toContain('claims add');
    expect(all).not.toContain('finalize');
    expect(all).not.toContain('intent-release');
  });

  test('invalid agent session (missing task metadata): uncertain_state, fail safe, re-register', () => {
    const r = recovery({ agent: agent({ metadata: { operating_mode: 'build' } }) });
    expect(r.resume_state).toBe('uncertain_state');
    expect(r.confidence).toBe('low');
    expect(r.can_continue_existing_agent).toBe(false);
    expect(r.requires_new_agent).toBe(true);
    const all = r.recommended_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('intent-release');
    expect(all).not.toContain('claims reap');
  });
});

describe('recovery guidance — build agent workspace states', () => {
  test('active build, clean tree, no claims/intents: ready_to_claim (re-plan; released claims grant nothing)', () => {
    const r = recovery();
    expect(r.resume_state).toBe('ready_to_claim');
    expect(r.recommended_resume_action).toBe('plan_and_claim');
    expect(r.has_active_claims).toBe(false);
    expect(r.has_active_intents).toBe(false);
    expect(
      r.recommended_cli_commands.some((c) => c.includes('--profile build_pre_edit')),
    ).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('claims plan --agent agent-a'))).toBe(true);
    const all = r.recommended_cli_commands.join(' ');
    // A released/old claim never authorizes resume: no commit/release path here.
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('intent-release');
  });

  test('active clean claims without releasable intent: ready_to_continue', () => {
    const r = recovery({
      activeClaimsCount: 2,
      activeIntentsCount: 1,
      releasableIntentsCount: 0,
      changes: changes({ total: 1, unclaimed: 1 }),
    });
    expect(r.resume_state).toBe('ready_to_continue');
    expect(r.recommended_resume_action).toBe('continue_work');
    expect(r.has_active_claims).toBe(true);
    expect(r.has_active_intents).toBe(true);
    expect(r.has_unclaimed_dirty_files).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('git changes --agent agent-a'))).toBe(true);
    // Unclaimed dirty files are flagged — ownership unclear, do not touch.
    expect(r.warnings.some((w) => w.code === 'UNCLAIMED_DIRTY_FILES_PRESENT')).toBe(true);
  });

  test('dirty claimed files only: ready_to_commit with git changes/finalize/guard dry-run', () => {
    const r = recovery({
      changes: changes({ total: 2, claimed_by_agent: 2 }),
      activeClaimsCount: 2,
      activeIntentsCount: 1,
    });
    expect(r.resume_state).toBe('ready_to_commit');
    expect(r.recommended_resume_action).toBe('commit_via_guard');
    expect(r.has_dirty_claimed_files).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('git changes --agent agent-a'))).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('finalize check --agent agent-a'))).toBe(true);
    expect(
      r.recommended_cli_commands.some((c) => c.includes('commit guard --agent agent-a --dry-run')),
    ).toBe(true);
  });

  test('claimed dirty + unstaged unclaimed dirty: isolated_commit_possible with explicit warning', () => {
    const r = recovery({
      changes: changes({ total: 3, claimed_by_agent: 2, unclaimed: 1 }),
      activeClaimsCount: 2,
    });
    expect(r.resume_state).toBe('isolated_commit_possible');
    expect(r.confidence).toBe('medium');
    expect(r.recommended_resume_action).toBe('dry_run_isolated_commit');
    expect(r.has_unclaimed_dirty_files).toBe(true);
    expect(
      r.recommended_cli_commands.some((c) => c.includes('commit guard --agent agent-a --dry-run')),
    ).toBe(true);
    // The warning never calls unclaimed files safe: it says they are skipped/untouched.
    const warning = r.warnings.find((w) => w.code === 'ISOLATED_COMMIT_LIKELY');
    expect(warning).toBeDefined();
    expect(warning?.message.toLowerCase()).toMatch(/skip/);
    expect(warning?.message.toLowerCase()).not.toContain('safe to commit');
  });

  test('staged unclaimed dirty file: blocked_by_staged_unclaimed, inspect-only guidance', () => {
    const r = recovery({
      changes: changes({ total: 3, claimed_by_agent: 2, unclaimed: 1, staged_unclaimed: 1 }),
      activeClaimsCount: 2,
    });
    expect(r.resume_state).toBe('blocked_by_staged_unclaimed');
    expect(r.has_staged_blockers).toBe(true);
    expect(r.recommended_resume_action).toBe('inspect_staged_unclaimed');
    expect(r.blockers.some((b) => b.code === 'STAGED_UNCLAIMED_FILES_BLOCKED')).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('git changes --agent agent-a'))).toBe(true);
    const all = r.recommended_cli_commands.join(' ');
    // No commit recommendation and no raw-git unstage automation.
    expect(all).not.toContain('commit guard');
    expectSafeCommands(r.recommended_cli_commands);
  });

  test('staged other-agent claimed file: never ready_to_commit or isolated (guard would block GIT_INDEX_NOT_CLEAN)', () => {
    const r = recovery({
      changes: changes({
        total: 2,
        claimed_by_agent: 1,
        claimed_by_other_agent: 1,
        staged_claimed_by_other_agent: 1,
      }),
      activeClaimsCount: 1,
    });
    expect(r.resume_state).not.toBe('ready_to_commit');
    expect(r.resume_state).not.toBe('isolated_commit_possible');
    // Continuing is the safe primary action; the other agent resolves its own
    // staged file — never unstage or commit another agent's files.
    expect(r.resume_state).toBe('ready_to_continue');
    expectSafeCommands(r.recommended_cli_commands);
  });

  test('own clean releasable intent: ready_to_release with dry-run-first, own agent only', () => {
    const r = recovery({
      activeIntentsCount: 1,
      releasableIntentsCount: 1,
      activeClaimsCount: 1,
    });
    expect(r.resume_state).toBe('ready_to_release');
    expect(r.recommended_resume_action).toBe('release_clean_intent');
    expect(r.has_releasable_clean_intents).toBe(true);
    const release = r.recommended_cli_commands.filter((c) => c.includes('intent-release'));
    expect(release.length).toBeGreaterThan(0);
    for (const c of release) {
      expect(c).toContain('--agent agent-a');
      expect(c).toContain('--dry-run');
    }
  });

  test('dirty own intent is NOT ready_to_release (commit comes first)', () => {
    const r = recovery({
      activeIntentsCount: 1,
      releasableIntentsCount: 0,
      activeClaimsCount: 1,
      changes: changes({ total: 1, claimed_by_agent: 1 }),
    });
    expect(r.resume_state).toBe('ready_to_commit');
    expect(r.has_releasable_clean_intents).toBe(false);
    expect(r.recommended_cli_commands.join(' ')).not.toContain('intent-release');
  });

  test('still-blocking conflict involving the agent (nothing committable): blocked_by_conflict', () => {
    const r = recovery({
      conflictTriages: [
        { requesting_agent_id: 'agent-a', blocking_agent_id: 'agent-b', triage_status: 'still_blocking' },
      ],
    });
    expect(r.resume_state).toBe('blocked_by_conflict');
    expect(r.recommended_resume_action).toBe('triage_conflict');
    expect(
      r.recommended_cli_commands.some((c) => c.includes('--profile conflict_resolution')),
    ).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('conflicts list'))).toBe(true);
  });

  test('committable claimed files outrank a conflict: ready_to_commit with conflict warning', () => {
    const r = recovery({
      changes: changes({ total: 1, claimed_by_agent: 1 }),
      activeClaimsCount: 1,
      conflictTriages: [
        { requesting_agent_id: 'agent-a', blocking_agent_id: 'agent-b', triage_status: 'still_blocking' },
      ],
    });
    expect(r.resume_state).toBe('ready_to_commit');
    expect(r.warnings.some((w) => w.code === 'CONFLICTS_STILL_BLOCKING')).toBe(true);
  });

  test('stale coordination is a secondary notice with housekeeping guidance, not a primary state', () => {
    const r = recovery({ staleCoordinationPresent: true });
    expect(r.resume_state).toBe('ready_to_claim');
    expect(r.warnings.some((w) => w.code === 'STALE_COORDINATION_PRESENT')).toBe(true);
    expect(
      r.recommended_cli_commands.some((c) => c.includes('--profile coordination_housekeeping')),
    ).toBe(true);
    expect(r.recommended_cli_commands.some((c) => c.includes('claims reap --dry-run'))).toBe(true);
    // Never a non-dry-run reap.
    expect(
      r.recommended_cli_commands.some((c) => c.includes('claims reap') && !c.includes('--dry-run')),
    ).toBe(false);
  });

  test('git unavailable fails safe: uncertain_state, no commit/release/cleanup guidance', () => {
    const r = recovery({
      changes: { ...changes({ total: 1, claimed_by_agent: 1 }), ok: false },
      activeClaimsCount: 1,
    });
    expect(r.resume_state).toBe('uncertain_state');
    expect(r.confidence).toBe('low');
    expect(r.requires_rebootstrap).toBe(true);
    expect(r.recommended_resume_action).toBe('rebootstrap_and_inspect');
    const all = r.recommended_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('intent-release');
    expect(all).not.toContain('claims reap');
  });

  test('alive agent past half TTL keeps its primary state but requires_heartbeat', () => {
    const r = recovery({
      now: new Date(Date.parse(T0) + RUNTIME_HEARTBEAT_RECOMMEND_AFTER_MS + 1000).toISOString(),
      changes: changes({ total: 1, claimed_by_agent: 1 }),
      activeClaimsCount: 1,
    });
    expect(r.resume_state).toBe('ready_to_commit');
    expect(r.requires_heartbeat).toBe(true);
    expect(
      r.recommended_cli_commands.some((c) => c.includes('agents heartbeat --agent agent-a')),
    ).toBe(true);
  });
});

describe('recovery guidance — MCP stale-server guidance (Part C)', () => {
  test('static CLI-fallback guidance is always present, bounded, and references real commands', () => {
    const r = recovery();
    expect(r.mcp_stale_guidance.length).toBeGreaterThan(0);
    expect(r.mcp_stale_guidance.length).toBeLessThanOrEqual(4);
    const text = r.mcp_stale_guidance.join(' ');
    expect(text).toContain('vibecode mcp tools --json');
    expect(text.toLowerCase()).toMatch(/restart|reconnect/);
    expect(text.toLowerCase()).toContain('cli');
  });

  test('no false stale-server warning in normal states (core cannot know the expected count)', () => {
    const r = recovery();
    expect(r.warnings.some((w) => /server|mcp/i.test(w.code))).toBe(false);
    expect(r.blockers.some((b) => /server|mcp/i.test(b.code))).toBe(false);
  });
});

describe('recovery guidance — safety and bounds across all states', () => {
  const inputs: Array<Partial<AgentRuntimeAwarenessInput>> = [
    {},
    { agent: null, requestedAgentId: null },
    { agent: null, requestedAgentId: 'agent-gone' },
    { agent: agent({ status: 'terminated' }) },
    { agent: agent({ status: 'stale' }) },
    { agent: agent({ metadata: { operating_mode: 'read_only', task: 't' } }) },
    { agent: agent({ metadata: { operating_mode: 'build' } }) },
    { changes: changes({ total: 2, claimed_by_agent: 2 }), activeClaimsCount: 2 },
    { changes: changes({ total: 3, claimed_by_agent: 2, unclaimed: 1 }), activeClaimsCount: 2 },
    { changes: changes({ total: 3, claimed_by_agent: 2, unclaimed: 1, staged_unclaimed: 1 }), activeClaimsCount: 2 },
    { activeIntentsCount: 1, releasableIntentsCount: 1, activeClaimsCount: 1 },
    { conflictTriages: [{ requesting_agent_id: 'agent-a', blocking_agent_id: 'b', triage_status: 'still_blocking' }] },
    { staleCoordinationPresent: true },
    { changes: { ...changes(), ok: false } },
  ];

  test('every state produces a known resume_state, safe bounded commands, and a one-line summary', () => {
    for (const over of inputs) {
      const r = recovery(over);
      expect(AGENT_RESUME_STATES).toContain(r.resume_state);
      expect(r.summary.length).toBeGreaterThan(0);
      expect(r.summary).toContain(r.resume_state);
      expect(r.summary).not.toContain('\n');
      expectSafeCommands(r.recommended_cli_commands);
      expect(r.recommended_cli_commands.length).toBeLessThanOrEqual(RECOVERY_MAX_RECOMMENDATIONS);
      expect(r.recommended_next_tools.length).toBeLessThanOrEqual(RECOVERY_MAX_RECOMMENDATIONS);
      expect(new Set(r.recommended_cli_commands).size).toBe(r.recommended_cli_commands.length);
      expect(new Set(r.recommended_next_tools).size).toBe(r.recommended_next_tools.length);
      for (const tool of r.recommended_next_tools) {
        expect(tool.startsWith('vibecode_')).toBe(true);
      }
    }
  });

  test('no state ever recommends cross-agent release, force cleanup, or .vibecode editing', () => {
    for (const over of inputs) {
      const r = recovery(over);
      const all = [
        ...r.recommended_cli_commands,
        ...r.mcp_stale_guidance,
        r.summary,
        ...r.warnings.map((w) => w.message),
        ...r.blockers.map((b) => b.message),
      ].join(' ');
      expect(all).not.toMatch(/--force/i);
      expect(all).not.toMatch(/state\.json/i);
      // Releases are only ever recommended for the agent's own intents.
      for (const c of r.recommended_cli_commands) {
        if (c.includes('intent-release')) {
          expect(c).toContain('--agent agent-a');
          expect(c).toContain('--dry-run');
        }
      }
    }
  });

  test('classifier is pure: direct call equals the embedded section and never mutates input', () => {
    const input = baseInput({ changes: changes({ total: 2, claimed_by_agent: 2 }), activeClaimsCount: 2 });
    const before = JSON.stringify(input);
    const awareness = getAgentRuntimeAwareness(input);
    const { recovery: embedded, ...base } = awareness;
    const direct = getAgentRecoveryGuidance({ awareness: base, activeClaimsCount: 2 });
    expect(direct).toEqual(embedded);
    expect(JSON.stringify(input)).toBe(before);
  });
});
