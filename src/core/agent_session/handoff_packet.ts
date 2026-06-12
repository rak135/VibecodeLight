import {
  getAgentOperatingMode,
  getAgentTask,
  type AgentOperatingMode,
} from '../coordination/agent_operating_mode.js';
import { listAgents } from '../coordination/agents.js';
import { listClaimIntents } from '../coordination/bulk_claims.js';
import { listFileClaims } from '../coordination/claims.js';
import { listConflicts, type ConflictRecord } from '../coordination/conflicts.js';
import { listConflictTriages } from '../coordination/conflict_triage.js';
import { summarizeStaleCoordination } from '../coordination/stale_coordination.js';
import type { AgentSession, AgentStatus, ClaimIntent, FileClaim } from '../coordination/types.js';
import { getGitChangesSummary } from '../workspace/git_changes_summary.js';
import type { GitReadOnlyRunner } from '../workspace/git_status.js';
import {
  RUNTIME_AWARENESS_TASK_MAX_CHARS,
  type RuntimeAwarenessChanges,
  type RuntimeConflictTriage,
  type RuntimeNotice,
} from './runtime_awareness.js';

/**
 * Phase 4A — read-only handoff packet / team workflow boundaries.
 *
 * When one agent stops and a human (or another agent) must decide who continues,
 * the open questions are always the same: what was this agent doing, what does
 * it still own, is the shared tree safe, and what must happen BEFORE anyone else
 * edits? The handoff packet answers those questions in one bounded, read-only
 * DTO with a single primary `handoff_state`, explicit prerequisites, exact safe
 * commands for the current agent, registration guidance for the next agent, and
 * hard `do_not_do` boundaries.
 *
 * Hard rules (handoff VISIBILITY, never handoff EXECUTION):
 *   - read-only: prepare never transfers claims, never assigns the next agent,
 *     never releases/claims/reaps/resolves/cleans anything, never heartbeats,
 *     and never touches git or source files;
 *   - the next agent always registers separately and claims exact files itself —
 *     released or old claims authorize nothing;
 *   - mirrors — never weakens — the real policies: dirty claimed files mean
 *     commit-or-revert first, staged unclaimed/other-agent files hard-block,
 *     unclaimed dirty files are never called safe, intent release is
 *     same-agent only, and ambiguous state fails safe (`uncertain_state`);
 *   - bounded output (capped samples, fixed lists, capped task text);
 *   - recommendations are real, safe commands only: no raw git mutation, no
 *     cross-agent release, no force cleanup, no `.vibecode` editing.
 */

/** Ordered canonical handoff states (most blocking lifecycle states first). */
export const AGENT_HANDOFF_STATES = [
  'terminated_or_missing_agent',
  'stale_agent_needs_heartbeat',
  'read_only_report',
  'blocked_by_staged_files',
  'commit_before_handoff',
  'isolated_commit_before_handoff',
  'blocked_by_conflict',
  'ready_after_release',
  'ready_to_handoff',
  'uncertain_state',
] as const;

export type AgentHandoffState = (typeof AGENT_HANDOFF_STATES)[number];

/** Machine-readable prerequisite tokens for `required_before_handoff`. */
export const HANDOFF_REQUIRED_ACTIONS = [
  'register_new_agent',
  'heartbeat_then_rerun_handoff_prepare',
  'inspect_and_unstage_staged_blockers',
  'commit_or_revert_dirty_claimed_files',
  'inspect_unclaimed_dirty_files',
  'triage_blocking_conflict',
  'release_own_clean_intents',
  'release_own_active_claims',
  'rebootstrap_and_inspect',
] as const;

export type HandoffRequiredAction = (typeof HANDOFF_REQUIRED_ACTIONS)[number];

/** Default cap on sample lists in the packet. */
export const DEFAULT_HANDOFF_SAMPLE_ITEMS = 10;

/** Hard maximum for handoff max_items (defensively enforced in core). */
export const HANDOFF_MAX_ITEMS = 50;

/** Hard cap on each recommendation list (matches runtime awareness). */
export const HANDOFF_MAX_RECOMMENDATIONS = 12;

/**
 * Explicit boundary guidance for the NEXT agent. Static and bounded by design:
 * these are the cross-agent safety rules that hold in every handoff state.
 */
export const HANDOFF_DO_NOT_DO: readonly string[] = Object.freeze([
  'Do not edit files claimed by another active agent.',
  'Do not assume released claims still authorize edits — register, plan, and claim the exact files yourself.',
  "Do not release another agent's intent — intent release is same-agent only.",
  'Do not transfer or reuse the previous agent’s claims; ownership transfer does not exist.',
  'Do not hand-edit .vibecode coordination state — use the coordination commands.',
  'Do not bypass the commit guard with raw git add/commit.',
  'Do not treat skipped or unclaimed dirty files as safe — inspect shared-tree state before editing.',
  'Do not claim directories or globs — claim explicit files only.',
]);

/** Compact, bounded, read-only handoff packet. */
export interface AgentHandoffPacket {
  agent_id: string;
  agent: {
    registered: boolean;
    status: AgentStatus | null;
    operating_mode: AgentOperatingMode | null;
    task: string | null;
    task_truncated: boolean;
    heartbeat_age_ms: number | null;
  };
  handoff: {
    handoff_state: AgentHandoffState;
    /** True only when another agent may safely register and continue now. */
    handoff_ready: boolean;
    /** One bounded line: `<handoff_state> — <what must happen>`. */
    summary: string;
    next_agent_may_continue: boolean;
    requires_current_agent_action: boolean;
    required_before_handoff: HandoffRequiredAction[];
  };
  owned_work: {
    active_claims_count: number;
    active_intents_count: number;
    releasable_intents_count: number;
    dirty_claimed_files_count: number;
    sample_claimed_paths: string[];
    sample_intent_ids: string[];
    samples_truncated: boolean;
  };
  workspace: {
    git_available: boolean;
    dirty: boolean;
    unclaimed_dirty_count: number;
    staged_unclaimed_count: number;
    staged_other_agent_count: number;
  };
  coordination: {
    conflicts_involving_agent_count: number;
    still_blocking_conflicts_involving_agent_count: number;
    stale_coordination_present: boolean;
  };
  /** Safe next MCP tools for the CURRENT agent (or the human preparing handoff). */
  safe_next_tools: string[];
  /** Safe next CLI commands for the CURRENT agent. */
  safe_cli_commands: string[];
  /** Registration/orientation commands for the NEXT agent (never a transfer). */
  next_agent_cli_commands: string[];
  do_not_do: string[];
  warnings: RuntimeNotice[];
  blockers: RuntimeNotice[];
  checked_at: string;
}

/** The already-loaded coordination data the pure builder consumes. */
export interface AgentHandoffPacketBuildInput {
  /** Resolved session (computed stale-aware status), even when terminated; null when missing. */
  agent: AgentSession | null;
  /** The agent_id the caller asked to prepare a handoff for. */
  requestedAgentId: string;
  changes: RuntimeAwarenessChanges;
  /** The agent's own ACTIVE claims (never released ones — those grant nothing). */
  ownActiveClaims: readonly FileClaim[];
  /** The agent's own ACTIVE work intents. */
  ownActiveIntents: readonly ClaimIntent[];
  /** Count of intents releasable right now (clean-tree condition already applied). */
  releasableIntentsCount: number;
  /** Triage summaries of unresolved conflicts. */
  conflictTriages?: readonly RuntimeConflictTriage[];
  staleCoordinationPresent: boolean;
  /** Cap on sample lists (default {@link DEFAULT_HANDOFF_SAMPLE_ITEMS}). */
  maxItems?: number;
  /** Clock (ISO-8601). */
  now: string;
}

function notice(code: string, severity: RuntimeNotice['severity'], message: string): RuntimeNotice {
  return { code, severity, message };
}

/** Bounded, deduped recommendation builder. */
class Recommendations {
  readonly tools: string[] = [];
  readonly commands: string[] = [];

  tool(...names: string[]): void {
    for (const name of names) {
      if (this.tools.length >= HANDOFF_MAX_RECOMMENDATIONS) return;
      if (!this.tools.includes(name)) this.tools.push(name);
    }
  }

  command(...commands: string[]): void {
    for (const command of commands) {
      if (this.commands.length >= HANDOFF_MAX_RECOMMENDATIONS) return;
      if (!this.commands.includes(command)) this.commands.push(command);
    }
  }
}

const REGISTER_COMMAND =
  'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json';

const SUMMARY_HINT_BY_STATE: Readonly<Record<AgentHandoffState, string>> = Object.freeze({
  terminated_or_missing_agent:
    'no reliable handoff from a terminated/missing agent — the next agent registers fresh and treats old claims as coordination state, never as authorization.',
  stale_agent_needs_heartbeat:
    'the agent is stale — heartbeat and re-run handoff prepare before handing off; never hand off based on stale state.',
  read_only_report:
    'read-only session — this packet is a report; there are no claims or commits to hand off.',
  blocked_by_staged_files:
    'staged unclaimed/other-agent files block handoff — inspect and unstage them safely; never commit them.',
  commit_before_handoff:
    'dirty claimed files exist — commit through the guard (or revert) before another agent continues.',
  isolated_commit_before_handoff:
    'dirty claimed files plus unrelated unclaimed dirty files — the commit guard may make an ISOLATED commit; skipped files are not safe and not owned by this agent.',
  blocked_by_conflict:
    'a still-blocking conflict involves this agent — triage it before handoff; never auto-resolve.',
  ready_after_release:
    'own clean active claims/intents remain — dry-run then release them before another agent claims the same files.',
  ready_to_handoff:
    'no dirty claimed files, no blockers, nothing unreleased — the next agent may register and plan claims normally.',
  uncertain_state:
    'state could not be classified safely — inspect only; do not commit, release, or hand off.',
});

const REQUIRED_BY_STATE: Readonly<Record<AgentHandoffState, HandoffRequiredAction[]>> = Object.freeze({
  terminated_or_missing_agent: ['register_new_agent'],
  stale_agent_needs_heartbeat: ['heartbeat_then_rerun_handoff_prepare'],
  read_only_report: [],
  blocked_by_staged_files: ['inspect_and_unstage_staged_blockers'],
  commit_before_handoff: ['commit_or_revert_dirty_claimed_files'],
  isolated_commit_before_handoff: ['commit_or_revert_dirty_claimed_files', 'inspect_unclaimed_dirty_files'],
  blocked_by_conflict: ['triage_blocking_conflict'],
  ready_after_release: [], // filled per intents-vs-claims below
  ready_to_handoff: [],
  uncertain_state: ['rebootstrap_and_inspect'],
});

/**
 * Build the handoff packet from already-loaded coordination data. Pure and
 * read-only: inputs are never mutated and nothing is loaded, spawned, written,
 * released, claimed, or transferred.
 */
export function buildAgentHandoffPacket(input: AgentHandoffPacketBuildInput): AgentHandoffPacket {
  const rawMaxItems = input.maxItems && input.maxItems > 0 ? input.maxItems : DEFAULT_HANDOFF_SAMPLE_ITEMS;
  if (rawMaxItems > HANDOFF_MAX_ITEMS) {
    throw new Error(`max_items ${rawMaxItems} exceeds maximum ${HANDOFF_MAX_ITEMS}`);
  }
  const maxItems = rawMaxItems;
  const warnings: RuntimeNotice[] = [];
  const blockers: RuntimeNotice[] = [];
  const rec = new Recommendations();

  const agent = input.agent;
  const agentId = agent?.agent_id ?? input.requestedAgentId;
  const status: AgentStatus | null = agent?.status ?? null;
  const operatingMode = agent ? getAgentOperatingMode(agent) : null;
  const rawTask = agent ? getAgentTask(agent) : null;
  const taskTruncated = rawTask !== null && rawTask.length > RUNTIME_AWARENESS_TASK_MAX_CHARS;
  const task = rawTask === null
    ? null
    : taskTruncated
      ? rawTask.slice(0, RUNTIME_AWARENESS_TASK_MAX_CHARS)
      : rawTask;

  // Heartbeat age is computed only; prepare never heartbeats.
  const nowMs = Date.parse(input.now);
  let heartbeatAgeMs: number | null = null;
  if (agent) {
    const beatMs = Date.parse(agent.last_heartbeat_at);
    if (!Number.isNaN(beatMs) && !Number.isNaN(nowMs)) {
      heartbeatAgeMs = Math.max(0, nowMs - beatMs);
    }
  }

  const counts = { ...input.changes.counts };
  const gitAvailable = input.changes.ok;
  const dirty = gitAvailable && input.changes.dirty;
  const unclaimedDirty = counts.unclaimed + counts.stale_claim_overlap;
  const stagedBlockers = counts.staged_unclaimed + counts.staged_claimed_by_other_agent;
  const dirtyClaimed = counts.claimed_by_agent;

  const triages = input.conflictTriages ?? [];
  const involving = triages.filter(
    (t) => t.requesting_agent_id === agentId || t.blocking_agent_id === agentId,
  );
  const stillBlockingInvolving = involving.filter((t) => t.triage_status === 'still_blocking');

  const activeClaimsCount = input.ownActiveClaims.length;
  const activeIntentsCount = input.ownActiveIntents.length;
  const validSession = agent !== null && operatingMode !== null && rawTask !== null;
  const isStale = status === 'stale' || status === 'unknown';

  // --- primary state classification (lifecycle first, then workspace, fail safe) ---
  let state: AgentHandoffState;
  if (agent === null || status === 'terminated') {
    state = 'terminated_or_missing_agent';
  } else if (!validSession) {
    state = 'uncertain_state';
  } else if (isStale) {
    state = 'stale_agent_needs_heartbeat';
  } else if (operatingMode === 'read_only') {
    state = 'read_only_report';
  } else if (!gitAvailable) {
    state = 'uncertain_state';
  } else if (stagedBlockers > 0) {
    state = 'blocked_by_staged_files';
  } else if (dirtyClaimed > 0) {
    state = unclaimedDirty > 0 ? 'isolated_commit_before_handoff' : 'commit_before_handoff';
  } else if (stillBlockingInvolving.length > 0) {
    state = 'blocked_by_conflict';
  } else if (activeClaimsCount > 0 || activeIntentsCount > 0) {
    state = 'ready_after_release';
  } else {
    state = 'ready_to_handoff';
  }

  const handoffReady = state === 'ready_to_handoff' || state === 'read_only_report';
  // A terminated/missing agent cannot act; every other non-ready state needs
  // the current agent (or the human driving it) to act before handoff.
  const requiresCurrentAgentAction = !handoffReady && state !== 'terminated_or_missing_agent';

  const requiredBeforeHandoff: HandoffRequiredAction[] = [...REQUIRED_BY_STATE[state]];
  if (state === 'ready_after_release') {
    requiredBeforeHandoff.push(
      activeIntentsCount > 0 ? 'release_own_clean_intents' : 'release_own_active_claims',
    );
  }

  // --- per-state notices + safe commands for the CURRENT agent ---
  switch (state) {
    case 'terminated_or_missing_agent':
      blockers.push(
        agent === null
          ? notice(
              'AGENT_NOT_FOUND',
              'block',
              `agent_id ${agentId} is not a registered agent; a reliable handoff packet cannot be prepared. The next agent registers fresh — old claims are coordination state, never authorization.`,
            )
          : notice(
              'AGENT_TERMINATED',
              'block',
              `Agent ${agentId} is terminated; its claims do not transfer. Register a new agent and treat leftover state as coordination housekeeping.`,
            ),
      );
      rec.tool('vibecode_session_start');
      rec.command(REGISTER_COMMAND);
      break;
    case 'stale_agent_needs_heartbeat':
      warnings.push(
        notice(
          'AGENT_STALE',
          'high',
          `Agent ${agentId} is ${status}. Heartbeat, then re-run handoff prepare — never hand off based on stale state.`,
        ),
      );
      rec.tool('vibecode_session_start');
      rec.command(
        `vibecode agents heartbeat --agent ${agentId} --json`,
        `vibecode session bootstrap --agent ${agentId} --json`,
        `vibecode handoff prepare --agent ${agentId} --json`,
      );
      break;
    case 'read_only_report':
      warnings.push(
        notice(
          'READ_ONLY_AGENT',
          'info',
          `Agent ${agentId} is read_only: this packet is a report only — no claims, commits, or releases are involved.`,
        ),
      );
      rec.tool('vibecode_workspace_snapshot', 'vibecode_project_instructions');
      rec.command('vibecode tools profile --profile read_only_orientation --json');
      break;
    case 'blocked_by_staged_files':
      blockers.push(
        notice(
          'STAGED_FILES_BLOCK_HANDOFF',
          'block',
          `${stagedBlockers} staged file(s) outside this agent's committable set (unclaimed/other-agent/generated) block handoff. Inspect and unstage them safely yourself — never commit them.`,
        ),
      );
      rec.tool('vibecode_changes', 'vibecode_build_finish');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode finalize check --agent ${agentId} --json`,
      );
      break;
    case 'commit_before_handoff':
    case 'isolated_commit_before_handoff':
      if (state === 'isolated_commit_before_handoff') {
        warnings.push(
          notice(
            'ISOLATED_COMMIT_LIKELY',
            'warning',
            `Finalize is blocked by ${unclaimedDirty} unclaimed dirty file(s), but the commit guard may make an ISOLATED commit of your ${dirtyClaimed} claimed file(s). Skipped unclaimed files are not safe and not owned by this agent — they stay dirty and are never staged or committed.`,
          ),
        );
      }
      rec.tool('vibecode_changes', 'vibecode_build_finish');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode finalize check --agent ${agentId} --json`,
        `vibecode commit guard --agent ${agentId} --dry-run --json`,
      );
      break;
    case 'blocked_by_conflict':
      blockers.push(
        notice(
          'CONFLICT_BLOCKS_HANDOFF',
          'block',
          `${stillBlockingInvolving.length} still-blocking conflict(s) involve this agent. Triage them before handoff; resolution is explicit, never automatic.`,
        ),
      );
      rec.tool('vibecode_workspace_snapshot');
      rec.command(
        'vibecode tools profile --profile conflict_resolution --json',
        'vibecode conflicts list --json',
      );
      break;
    case 'ready_after_release':
      if (activeIntentsCount > 0) {
        warnings.push(
          notice(
            'UNRELEASED_OWN_INTENTS',
            'warning',
            `${activeIntentsCount} clean active own intent(s) should be released before another agent continues — dry-run the release first. The next agent must not edit the claimed files until release.`,
          ),
        );
        rec.tool('vibecode_build_scope');
        rec.command(
          `vibecode claims intents list --agent ${agentId} --status active --json`,
          `vibecode claims intent-release --agent ${agentId} --intent-id <intent_id> --dry-run --json`,
          `vibecode claims intent-release --agent ${agentId} --intent-id <intent_id> --json`,
        );
      } else {
        warnings.push(
          notice(
            'UNRELEASED_OWN_CLAIMS',
            'warning',
            `${activeClaimsCount} active own claim(s) without an intent remain. Release them before another agent claims the same files.`,
          ),
        );
        rec.tool('vibecode_build_scope');
        rec.command(
          `vibecode claims list --agent ${agentId} --json`,
          'vibecode claims release --claim <claim_id> --json',
        );
      }
      break;
    case 'ready_to_handoff':
      rec.tool('vibecode_session_start');
      rec.command(`vibecode agents terminate --agent ${agentId} --json`);
      break;
    case 'uncertain_state':
      if (!gitAvailable) {
        blockers.push(
          notice(
            'GIT_UNAVAILABLE',
            'block',
            'git changed files could not be determined; handoff readiness is unknown and fails closed. Inspect only — do not commit, release, or hand off.',
          ),
        );
      } else {
        blockers.push(
          notice(
            'INVALID_AGENT_SESSION',
            'block',
            `Agent ${agentId} is missing required session metadata (operating_mode/task); handoff state cannot be classified safely. Inspect only.`,
          ),
        );
      }
      rec.tool('vibecode_session_start', 'vibecode_changes');
      rec.command(`vibecode session bootstrap --agent ${agentId} --json`);
      break;
  }

  // --- secondary notices (never compete with the primary state) ---
  if (
    unclaimedDirty > 0 &&
    state !== 'isolated_commit_before_handoff' &&
    state !== 'blocked_by_staged_files' &&
    state !== 'uncertain_state'
  ) {
    warnings.push(
      notice(
        'UNCLAIMED_DIRTY_FILES_PRESENT',
        'warning',
        `${unclaimedDirty} unclaimed dirty file(s) exist in the shared tree — ownership is unclear and handoff does not make them safe. The next agent must inspect shared-tree state (vibecode git changes) before editing anything.`,
      ),
    );
  }
  if (input.staleCoordinationPresent) {
    warnings.push(
      notice(
        'STALE_COORDINATION_PRESENT',
        'warning',
        'Stale coordination state (stale agents/claims/intents) exists. Housekeeping is explicit and dry-run-first; it does not block this handoff unless it affects the owned work above.',
      ),
    );
    rec.tool('vibecode_build_scope');
    rec.command(
      'vibecode tools profile --profile coordination_housekeeping --json',
      'vibecode claims reap --dry-run --json',
    );
  }

  // --- bounded owned-work samples ---
  const samplePaths = input.ownActiveClaims.slice(0, maxItems).map((c) => c.path);
  const sampleIntentIds = input.ownActiveIntents.slice(0, maxItems).map((i) => i.intent_id);
  const samplesTruncated =
    samplePaths.length < activeClaimsCount || sampleIntentIds.length < activeIntentsCount;

  // --- next agent guidance (independent registration, never a transfer) ---
  const nextAgentCommands = [
    'vibecode session bootstrap --register --agent-mode build --task "<task>" --json',
    'vibecode tools profile --profile build_pre_edit --json',
    'vibecode tools profile --profile team_handoff --json',
  ];

  return {
    agent_id: agentId,
    agent: {
      registered: agent !== null,
      status,
      operating_mode: operatingMode,
      task,
      task_truncated: taskTruncated,
      heartbeat_age_ms: heartbeatAgeMs,
    },
    handoff: {
      handoff_state: state,
      handoff_ready: handoffReady,
      summary: `${state} — ${SUMMARY_HINT_BY_STATE[state]}`,
      next_agent_may_continue: handoffReady,
      requires_current_agent_action: requiresCurrentAgentAction,
      required_before_handoff: requiredBeforeHandoff,
    },
    owned_work: {
      active_claims_count: activeClaimsCount,
      active_intents_count: activeIntentsCount,
      releasable_intents_count: input.releasableIntentsCount,
      dirty_claimed_files_count: gitAvailable ? dirtyClaimed : 0,
      sample_claimed_paths: samplePaths,
      sample_intent_ids: sampleIntentIds,
      samples_truncated: samplesTruncated,
    },
    workspace: {
      git_available: gitAvailable,
      dirty,
      unclaimed_dirty_count: gitAvailable ? unclaimedDirty : 0,
      staged_unclaimed_count: gitAvailable ? counts.staged_unclaimed : 0,
      staged_other_agent_count: gitAvailable ? counts.staged_claimed_by_other_agent : 0,
    },
    coordination: {
      conflicts_involving_agent_count: involving.length,
      still_blocking_conflicts_involving_agent_count: stillBlockingInvolving.length,
      stale_coordination_present: input.staleCoordinationPresent,
    },
    safe_next_tools: rec.tools,
    safe_cli_commands: rec.commands,
    next_agent_cli_commands: nextAgentCommands,
    do_not_do: [...HANDOFF_DO_NOT_DO],
    warnings,
    blockers,
    checked_at: input.now,
  };
}

export interface GetAgentHandoffPacketOptions {
  agent_id: string;
  max_items?: number;
  /** Clock seam (ISO-8601). */
  now?: string;
  /** Test seam: read-only git runner. */
  gitRunner?: GitReadOnlyRunner;
}

/**
 * Load the coordination/git state for one agent and build its handoff packet.
 * Strictly read-only: no register, no heartbeat, no claim/intent/conflict
 * mutation, no git mutation — only the same read-only listings the bootstrap
 * aggregator uses.
 */
export function getAgentHandoffPacket(
  repoRoot: string,
  options: GetAgentHandoffPacketOptions,
): AgentHandoffPacket {
  const now = options.now ?? new Date().toISOString();
  const agentId = options.agent_id;

  const agents = listAgents(repoRoot, { now });
  const agent = agents.find((a) => a.agent_id === agentId) ?? null;

  const changes = getGitChangesSummary(repoRoot, {
    now,
    agent_id: agentId,
    includeDiffStat: false,
    gitRunner: options.gitRunner,
  });

  const claims = listFileClaims(repoRoot, { now });
  const ownActiveClaims = claims.filter((c) => c.status === 'active' && c.agent_id === agentId);
  const intents = listClaimIntents(repoRoot, { now });
  const ownActiveIntents = intents.filter((i) => i.status === 'active' && i.agent_id === agentId);

  // Same clean-tree releasability condition the bootstrap uses: zero dirty
  // claimed files and zero unclaimed dirty files (full-tree counts).
  const releasable =
    ownActiveIntents.length > 0 &&
    changes.ok &&
    changes.summary.claimed_by_agent === 0 &&
    changes.summary.unclaimed === 0;

  // Conflict triage needs released claims too, so a conflict whose blocking
  // claim was released triages as `cleared` (matches vibecode_conflict_detail).
  const unresolved = listConflicts(repoRoot, undefined, { now }).filter(
    (c): c is ConflictRecord => Boolean(c) && typeof c === 'object',
  ).filter((c) => c.status === 'detected');
  const claimsForTriage = listFileClaims(repoRoot, { now, includeReleased: true });
  const triageResult = listConflictTriages({
    agents,
    claims: claimsForTriage,
    intents,
    conflicts: unresolved,
    currentAgentId: agentId,
    now,
  });

  const staleCoordination = summarizeStaleCoordination({
    agents,
    claims,
    intents,
    currentAgentId: agentId,
    maxItems: options.max_items,
  });

  return buildAgentHandoffPacket({
    agent,
    requestedAgentId: agentId,
    changes: {
      ok: changes.ok,
      dirty: changes.ok ? changes.dirty : false,
      counts: {
        total: changes.summary.changed_count,
        claimed_by_agent: changes.summary.claimed_by_agent,
        claimed_by_other_agent: changes.summary.claimed_by_other_active_agent,
        unclaimed: changes.summary.unclaimed,
        stale_claim_overlap: changes.summary.stale_claim_overlap,
        generated_or_ignored: changes.summary.generated_or_ignored,
        staged_unclaimed: changes.summary.staged_unclaimed,
        staged_claimed_by_other_agent: changes.summary.staged_claimed_by_other_agent,
      },
    },
    ownActiveClaims,
    ownActiveIntents,
    releasableIntentsCount: releasable ? ownActiveIntents.length : 0,
    conflictTriages: triageResult.conflicts,
    staleCoordinationPresent: staleCoordination.has_stale_state,
    maxItems: options.max_items,
    now,
  });
}
