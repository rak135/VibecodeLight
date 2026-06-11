import { describe, expect, test } from 'vitest';

import {
  getAgentRuntimeAwareness,
  RUNTIME_HEARTBEAT_RECOMMEND_AFTER_MS,
  RUNTIME_AWARENESS_TASK_MAX_CHARS,
  type AgentRuntimeAwarenessInput,
  type RuntimeAwarenessChanges,
} from '../../../src/core/agent_session/runtime_awareness.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import type { AgentSession } from '../../../src/core/coordination/types.js';

/**
 * Phase 3B — agent runtime awareness / preflight (pure core).
 *
 * What breaks if removed:
 *   - the preflight could mis-report lifecycle state (stale/terminated/read_only)
 *     and hand an agent unsafe edit/commit guidance;
 *   - shared-tree commit readiness (finalize vs isolated commit guard) could
 *     drift from the real finalize/commit-guard policy;
 *   - recommendations could regress to unsafe or nonexistent commands.
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
    metadata: { operating_mode: 'build', task: 'phase 3b work' },
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
    conflictTriages: [],
    staleCoordinationPresent: false,
    now: T0,
    ...over,
  };
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

describe('runtime awareness — agent lifecycle (Part B)', () => {
  test('active build agent on a clean tree: ok, can_edit, no blockers', () => {
    const result = getAgentRuntimeAwareness(baseInput());
    expect(result.blockers).toEqual([]);
    expect(result.agent.registered).toBe(true);
    expect(result.agent.agent_id).toBe('agent-a');
    expect(result.agent.status).toBe('active');
    expect(result.agent.operating_mode).toBe('build');
    expect(result.agent.heartbeat_age_ms).toBe(0);
    expect(result.agent.heartbeat_ttl_ms).toBe(HEARTBEAT_TTL_MS);
    expect(result.agent.needs_heartbeat).toBe(false);
    expect(result.commit_guard.can_edit).toBe(true);
    expect(result.workspace.dirty).toBe(false);
    expectSafeCommands(result.recommended_cli_commands);
  });

  test('stale build agent: warning + heartbeat/re-bootstrap recommendation, no edit/commit readiness', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({
        agent: agent({ status: 'stale' }),
        now: new Date(Date.parse(T0) + HEARTBEAT_TTL_MS * 2).toISOString(),
      }),
    );
    expect(result.agent.status).toBe('stale');
    expect(result.agent.needs_heartbeat).toBe(true);
    expect(result.warnings.some((w) => w.code === 'AGENT_STALE')).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.commit_guard.can_edit).toBe(false);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('agents heartbeat --agent agent-a')),
    ).toBe(true);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('session bootstrap --agent agent-a')),
    ).toBe(true);
    expect(result.recommended_next_tools).toContain('vibecode_agent_heartbeat');
    expectSafeCommands(result.recommended_cli_commands);
  });

  test('terminated agent: blocker, register-new-agent guidance, no edit/commit commands', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({
        agent: agent({ status: 'terminated' }),
        changes: changes({ total: 1, claimed_by_agent: 1 }),
      }),
    );
    expect(result.blockers.some((b) => b.code === 'AGENT_TERMINATED')).toBe(true);
    expect(result.commit_guard.can_edit).toBe(false);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
    expect(result.recommended_cli_commands.some((c) => c.includes('--register'))).toBe(true);
    expect(result.recommended_cli_commands.some((c) => c.includes('commit guard'))).toBe(false);
    expect(result.recommended_cli_commands.some((c) => c.includes('finalize'))).toBe(false);
  });

  test('missing agent (requested id not found): AGENT_NOT_FOUND blocker', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ agent: null, requestedAgentId: 'agent-gone' }),
    );
    expect(result.agent.registered).toBe(false);
    expect(result.agent.agent_id).toBe('agent-gone');
    expect(result.blockers.some((b) => b.code === 'AGENT_NOT_FOUND')).toBe(true);
    expect(result.commit_guard.can_edit).toBe(false);
  });

  test('unregistered (no agent requested): NOT_REGISTERED warning, register recommendation', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ agent: null, requestedAgentId: null }),
    );
    expect(result.blockers).toEqual([]);
    expect(result.warnings.some((w) => w.code === 'NOT_REGISTERED')).toBe(true);
    expect(result.recommended_cli_commands.some((c) => c.includes('--register'))).toBe(true);
    expect(result.commit_guard.can_edit).toBe(false);
  });

  test('read_only agent: no edit/claim/commit guidance', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({
        agent: agent({ metadata: { operating_mode: 'read_only', task: 'review' } }),
        changes: changes({ total: 2, claimed_by_agent: 1, unclaimed: 1 }),
      }),
    );
    expect(result.blockers).toEqual([]);
    expect(result.agent.operating_mode).toBe('read_only');
    expect(result.commit_guard.can_edit).toBe(false);
    expect(result.commit_guard.finalize_ready).toBe(false);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
    const all = result.recommended_cli_commands.join(' ');
    expect(all).not.toContain('commit guard');
    expect(all).not.toContain('claims plan');
    expect(all).not.toContain('claims add');
    expect(all).not.toContain('finalize');
  });

  test('invalid build session (missing task): INVALID_AGENT_SESSION blocker', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ agent: agent({ metadata: { operating_mode: 'build' } }) }),
    );
    expect(result.blockers.some((b) => b.code === 'INVALID_AGENT_SESSION')).toBe(true);
    expect(result.commit_guard.can_edit).toBe(false);
  });

  test('heartbeat recommendation appears after half the TTL without any mutation', () => {
    const input = baseInput({
      now: new Date(Date.parse(T0) + RUNTIME_HEARTBEAT_RECOMMEND_AFTER_MS + 1000).toISOString(),
    });
    const before = JSON.stringify(input.agent);
    const result = getAgentRuntimeAwareness(input);
    expect(result.agent.needs_heartbeat).toBe(true);
    expect(result.warnings.some((w) => w.code === 'HEARTBEAT_RECOMMENDED')).toBe(true);
    // Pure function: the input session is untouched.
    expect(JSON.stringify(input.agent)).toBe(before);
  });

  test('task is bounded in the agent section', () => {
    const longTask = 'x'.repeat(RUNTIME_AWARENESS_TASK_MAX_CHARS * 2);
    const result = getAgentRuntimeAwareness(
      baseInput({ agent: agent({ metadata: { operating_mode: 'build', task: longTask } }) }),
    );
    expect(result.agent.task?.length).toBe(RUNTIME_AWARENESS_TASK_MAX_CHARS);
    expect(result.agent.task_truncated).toBe(true);
  });
});

describe('runtime awareness — shared-tree commit readiness (Part D)', () => {
  test('clean tree: finalize ready, nothing committable, no warnings about files', () => {
    const result = getAgentRuntimeAwareness(baseInput());
    expect(result.workspace.dirty).toBe(false);
    expect(result.workspace.shared_tree_dirty).toBe(false);
    expect(result.commit_guard.finalize_ready).toBe(true);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
  });

  test('claimed dirty only: finalize + commit guard ready', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ changes: changes({ total: 2, claimed_by_agent: 2 }) }),
    );
    expect(result.commit_guard.finalize_ready).toBe(true);
    expect(result.commit_guard.commit_guard_ready).toBe(true);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
    expect(result.commit_guard.committable_count).toBe(2);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('commit guard --agent agent-a --dry-run')),
    ).toBe(true);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('finalize check --agent agent-a')),
    ).toBe(true);
  });

  test('claimed dirty + unstaged unclaimed dirty: finalize blocked, isolated commit likely', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ changes: changes({ total: 3, claimed_by_agent: 2, unclaimed: 1 }) }),
    );
    expect(result.commit_guard.finalize_ready).toBe(false);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(true);
    expect(result.workspace.shared_tree_dirty).toBe(true);
    expect(result.warnings.some((w) => w.code === 'ISOLATED_COMMIT_LIKELY')).toBe(true);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('commit guard --agent agent-a --dry-run')),
    ).toBe(true);
  });

  test('claimed dirty + staged unclaimed dirty: commit guard likely blocked', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({
        changes: changes({ total: 3, claimed_by_agent: 2, unclaimed: 1, staged_unclaimed: 1 }),
      }),
    );
    expect(result.commit_guard.finalize_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
    expect(result.commit_guard.staged_unclaimed_blockers).toBe(1);
    expect(result.warnings.some((w) => w.code === 'STAGED_UNCLAIMED_FILES_PRESENT')).toBe(true);
  });

  test('unclaimed dirty only: nothing committable by this agent', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ changes: changes({ total: 1, unclaimed: 1 }) }),
    );
    expect(result.commit_guard.finalize_ready).toBe(false);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
    expect(result.recommended_cli_commands.join(' ')).not.toContain('commit guard');
  });

  test('other-agent dirty only: finalize not blocked but nothing committable', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ changes: changes({ total: 1, claimed_by_other_agent: 1 }) }),
    );
    expect(result.commit_guard.finalize_ready).toBe(true);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
    expect(result.workspace.shared_tree_dirty).toBe(true);
  });

  test('stale-claim overlap counts as unclaimed for finalize readiness', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ changes: changes({ total: 2, claimed_by_agent: 1, stale_claim_overlap: 1 }) }),
    );
    expect(result.commit_guard.finalize_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(true);
  });

  test('git unavailable fails closed: no readiness, GIT_UNAVAILABLE warning', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ changes: { ...changes({ total: 1, claimed_by_agent: 1 }), ok: false } }),
    );
    expect(result.workspace.git_available).toBe(false);
    expect(result.commit_guard.finalize_ready).toBe(false);
    expect(result.commit_guard.commit_guard_ready).toBe(false);
    expect(result.commit_guard.isolated_commit_possible).toBe(false);
    expect(result.warnings.some((w) => w.code === 'GIT_UNAVAILABLE')).toBe(true);
  });
});

describe('runtime awareness — coordination (Part E)', () => {
  test('active own intent is counted; clean releasable intent recommends dry-run release', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({ activeIntentsCount: 1, releasableIntentsCount: 1 }),
    );
    expect(result.coordination.active_intents_count).toBe(1);
    expect(result.coordination.releasable_intents_count).toBe(1);
    expect(
      result.recommended_cli_commands.some((c) =>
        c.includes('claims intent-release --agent agent-a') && c.includes('--dry-run'),
      ),
    ).toBe(true);
    expectSafeCommands(result.recommended_cli_commands);
  });

  test('dirty own intent does not recommend release', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({
        activeIntentsCount: 1,
        releasableIntentsCount: 0,
        changes: changes({ total: 1, claimed_by_agent: 1 }),
      }),
    );
    expect(result.coordination.releasable_intents_count).toBe(0);
    expect(result.recommended_cli_commands.join(' ')).not.toContain('intent-release');
  });

  test('still-blocking conflict involving the agent recommends conflict_resolution', () => {
    const result = getAgentRuntimeAwareness(
      baseInput({
        conflictTriages: [
          { requesting_agent_id: 'agent-a', blocking_agent_id: 'agent-b', triage_status: 'still_blocking' },
          { requesting_agent_id: 'agent-x', blocking_agent_id: 'agent-y', triage_status: 'still_blocking' },
        ],
      }),
    );
    expect(result.coordination.conflicts_involving_agent_count).toBe(1);
    expect(result.coordination.still_blocking_conflicts_involving_agent_count).toBe(1);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('--profile conflict_resolution')),
    ).toBe(true);
    expect(result.recommended_cli_commands.some((c) => c.includes('conflicts list'))).toBe(true);
  });

  test('stale coordination recommends coordination_housekeeping and dry-run reap only', () => {
    const result = getAgentRuntimeAwareness(baseInput({ staleCoordinationPresent: true }));
    expect(result.coordination.stale_coordination_present).toBe(true);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('--profile coordination_housekeeping')),
    ).toBe(true);
    expect(
      result.recommended_cli_commands.some((c) => c.includes('claims reap --dry-run')),
    ).toBe(true);
    // Never a non-dry-run reap and never a cross-agent release.
    expect(
      result.recommended_cli_commands.some((c) => c.includes('claims reap') && !c.includes('--dry-run')),
    ).toBe(false);
  });
});

describe('runtime awareness — recommendations are safe and bounded (Part F)', () => {
  test('all recommendations across many states are vibecode commands with --json and no unsafe keywords', () => {
    const inputs: AgentRuntimeAwarenessInput[] = [
      baseInput(),
      baseInput({ agent: agent({ status: 'stale' }) }),
      baseInput({ agent: agent({ status: 'terminated' }) }),
      baseInput({ agent: null, requestedAgentId: null }),
      baseInput({ agent: agent({ metadata: { operating_mode: 'read_only', task: 't' } }) }),
      baseInput({ changes: changes({ total: 3, claimed_by_agent: 2, unclaimed: 1 }) }),
      baseInput({ changes: changes({ total: 2, claimed_by_agent: 1, staged_unclaimed: 1, unclaimed: 1 }) }),
      baseInput({ activeIntentsCount: 2, releasableIntentsCount: 2 }),
      baseInput({ staleCoordinationPresent: true }),
    ];
    for (const input of inputs) {
      const result = getAgentRuntimeAwareness(input);
      expectSafeCommands(result.recommended_cli_commands);
      expect(result.recommended_cli_commands.length).toBeLessThanOrEqual(12);
      expect(result.recommended_next_tools.length).toBeLessThanOrEqual(12);
      // Tools are deduplicated.
      expect(new Set(result.recommended_next_tools).size).toBe(result.recommended_next_tools.length);
      expect(new Set(result.recommended_cli_commands).size).toBe(result.recommended_cli_commands.length);
      for (const tool of result.recommended_next_tools) {
        expect(tool.startsWith('vibecode_')).toBe(true);
      }
    }
  });

  test('server section is null in core output (adapters fill it)', () => {
    const result = getAgentRuntimeAwareness(baseInput());
    expect(result.server).toBeNull();
  });
});
