import {
  getAgentOperatingMode,
  getAgentTask,
  type AgentOperatingMode,
} from '../coordination/agent_operating_mode.js';
import { listAgents } from '../coordination/agents.js';
import type { AgentSession, AgentStatus } from '../coordination/types.js';
import type { GitReadOnlyRunner } from '../workspace/git_status.js';
import {
  getAgentHandoffPacket,
  type AgentHandoffPacket,
  type AgentHandoffState,
  type HandoffRequiredAction,
} from './handoff_packet.js';
import {
  RUNTIME_AWARENESS_TASK_MAX_CHARS,
  type RuntimeNotice,
} from './runtime_awareness.js';

/**
 * Phase 4B — next-agent onboarding guidance from handoff packets (read-only).
 *
 * Phase 4A answers "what does the STOPPING agent still owe?". Phase 4B answers
 * the mirror question for the agent that wants to continue: is the previous
 * agent actually ready, is its work still claimed, may I register/continue as
 * a separate agent, which paths are still unavailable, what must I claim
 * myself, what exact commands do I run, and what must I never do? The guide
 * consumes the Phase 4A packet plus the (optional) next agent's own session
 * and classifies ONE primary onboarding state with explicit flags, separated
 * previous-agent vs next-agent command lists, and hard `do_not_do` boundaries.
 *
 * Hard rules (onboarding GUIDANCE, never handoff EXECUTION):
 *   - read-only: the guide never registers, heartbeats, releases, claims,
 *     reaps, resolves, transfers, assigns, or mutates git/source/coordination
 *     state — and never will;
 *   - ownership is NEVER transferred: the next agent always registers
 *     separately and claims exact files explicitly itself;
 *   - path lists come from the previous agent's handoff packet — Vibecode does
 *     not select the next agent's task scope and never auto-picks files;
 *   - release/commit commands for the previous agent's work are listed ONLY in
 *     `previous_agent_cli_commands` (same-agent only, dry-run first) — the next
 *     agent must not run them;
 *   - read_only/stale/terminated NEXT agents get no claim/edit/commit guidance;
 *   - ambiguous state fails safe (`uncertain_state`): inspect only.
 */

/** Ordered canonical onboarding states (most blocking first). */
export const HANDOFF_ONBOARDING_STATES = [
  'previous_agent_not_ready',
  'previous_agent_ready_after_release',
  'blocked_by_active_claims',
  'blocked_by_conflict',
  'stale_coordination_requires_housekeeping',
  'next_agent_stale_or_terminated',
  'next_agent_read_only',
  'next_agent_not_registered',
  'same_agent_resume',
  'ready_for_new_agent',
  'uncertain_state',
] as const;

export type HandoffOnboardingState = (typeof HANDOFF_ONBOARDING_STATES)[number];

/** Machine-readable prerequisite tokens for `required_before_continue`. */
export const HANDOFF_GUIDE_REQUIRED_ACTIONS = [
  'previous_agent_commit_or_revert',
  'previous_agent_release_intents',
  'previous_agent_release_claims',
  'previous_agent_heartbeat_and_rerun_prepare',
  'inspect_staged_blockers',
  'triage_blocking_conflict',
  'run_coordination_housekeeping_dry_run',
  'register_next_agent',
  'heartbeat_or_reregister_next_agent',
  'resume_same_agent_with_session_recovery',
  'plan_and_claim_explicit_files',
  'inspect_only',
] as const;

export type HandoffGuideRequiredAction = (typeof HANDOFF_GUIDE_REQUIRED_ACTIONS)[number];

/** Short machine-readable primary action token per onboarding state. */
export const HANDOFF_ONBOARDING_ACTIONS = [
  'wait_for_previous_agent',
  'wait_for_release',
  'run_housekeeping_dry_run',
  'triage_conflict',
  'heartbeat_or_reregister',
  'observe_read_only',
  'register_and_plan',
  'resume_same_agent',
  'plan_and_claim_explicitly',
  'inspect_only',
] as const;

export type HandoffOnboardingAction = (typeof HANDOFF_ONBOARDING_ACTIONS)[number];

/** Hard maximum for handoff guide max_items (matches the packet cap). */
export const HANDOFF_GUIDE_MAX_ITEMS = 50;

/** Default cap on path sample lists in the guide. */
export const DEFAULT_HANDOFF_GUIDE_ITEMS = 10;

/** Hard cap on each recommendation list (matches runtime awareness). */
export const HANDOFF_GUIDE_MAX_RECOMMENDATIONS = 12;

/**
 * Hard prohibitions for the NEXT agent. Static and bounded by design: these
 * cross-agent safety rules hold in every onboarding state.
 */
export const HANDOFF_GUIDE_DO_NOT_DO: readonly string[] = Object.freeze([
  'Do not treat this handoff guide as ownership transfer — no claims ever move between agents.',
  'Do not edit files still claimed by the previous agent (or any other active agent).',
  "Do not release another agent's intent — intent release is same-agent only; release commands listed for the previous agent are for THAT agent to run.",
  'Do not bypass the commit guard with raw git add/commit.',
  'Do not hand-edit .vibecode coordination state — use the coordination commands.',
  'Do not claim directories or globs — claim explicit files only.',
  'Do not assume candidate paths from this guide are automatically safe or complete — run claims plan first and decide scope from your own task.',
  'Do not assume released claims still authorize edits — register, plan, and claim the exact files yourself.',
]);

/**
 * Static clarification of where path lists come from. The guide never implies
 * Vibecode selected the next agent's scope.
 */
export const HANDOFF_GUIDE_PATH_GUIDANCE: readonly string[] = Object.freeze([
  'Path lists are bounded samples from the previous agent\'s handoff packet — they describe what that agent still owns, not what you should work on.',
  'You must explicitly claim every file you intend to edit (vibecode claims plan, then claims add-bulk) — Vibecode does not select or choose files for you.',
  'Decide your claim scope from your own task; run claims plan before claiming anything.',
]);

/** Compact, bounded, read-only next-agent onboarding guide. */
export interface NextAgentHandoffGuide {
  from_agent_id: string;
  for_agent_id: string | null;
  /** Condensed view of the previous agent's Phase 4A handoff packet. */
  handoff_source: {
    handoff_state: AgentHandoffState;
    handoff_ready: boolean;
    summary: string;
    requires_current_agent_action: boolean;
    required_before_handoff: HandoffRequiredAction[];
    active_claims_count: number;
    active_intents_count: number;
    dirty_claimed_files_count: number;
  };
  next_agent: {
    requested: boolean;
    registered: boolean;
    status: AgentStatus | null;
    operating_mode: AgentOperatingMode | null;
    task: string | null;
    task_truncated: boolean;
  };
  onboarding: {
    onboarding_state: HandoffOnboardingState;
    /** One bounded line: `<onboarding_state> — <what to do>`. */
    summary: string;
    recommended_action: HandoffOnboardingAction;
    /** True only when the next agent may register/bootstrap and plan explicit claims NOW. */
    can_continue_now: boolean;
    /** True when registering and planning (not editing) is already safe. */
    can_register_and_plan: boolean;
    /** Always true: the next agent claims exact files explicitly itself. */
    must_claim_explicitly: boolean;
    /** Always false: Vibecode never transfers ownership between agents. */
    ownership_transferred: boolean;
    /** True when for_agent_id equals from_agent_id — use session_recovery instead. */
    same_agent_resume: boolean;
  };
  /** Paths still unavailable because the previous agent's claims are ACTIVE. */
  blocked_paths: string[];
  /** Same paths, framed as needing a NEW explicit claim after the previous agent releases. */
  paths_requiring_new_claim_after_release: string[];
  paths_truncated: boolean;
  path_guidance: string[];
  required_before_continue: HandoffGuideRequiredAction[];
  /** Safe next MCP tools (for whichever agent the state says acts next). */
  safe_next_tools: string[];
  /** Commands ONLY the previous (from) agent runs — never the next agent. */
  previous_agent_cli_commands: string[];
  /** Commands the NEXT agent (or the human driving it) runs. */
  next_agent_cli_commands: string[];
  do_not_do: string[];
  warnings: RuntimeNotice[];
  blockers: RuntimeNotice[];
  checked_at: string;
}

/** The already-loaded data the pure builder consumes. */
export interface NextAgentHandoffGuideBuildInput {
  /** The previous agent's handoff packet (Phase 4A, already built). */
  packet: AgentHandoffPacket;
  /** Whether the caller passed a for_agent_id at all. */
  forAgentRequested: boolean;
  forAgentId: string | null;
  /** Resolved next-agent session (computed stale-aware status); null when missing. */
  forAgent: AgentSession | null;
  /** Cap on path sample lists (default {@link DEFAULT_HANDOFF_GUIDE_ITEMS}). */
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
  readonly previous: string[] = [];
  readonly next: string[] = [];

  tool(...names: string[]): void {
    for (const name of names) {
      if (this.tools.length >= HANDOFF_GUIDE_MAX_RECOMMENDATIONS) return;
      if (!this.tools.includes(name)) this.tools.push(name);
    }
  }

  previousCommand(...commands: string[]): void {
    for (const command of commands) {
      if (this.previous.length >= HANDOFF_GUIDE_MAX_RECOMMENDATIONS) return;
      if (!this.previous.includes(command)) this.previous.push(command);
    }
  }

  nextCommand(...commands: string[]): void {
    for (const command of commands) {
      if (this.next.length >= HANDOFF_GUIDE_MAX_RECOMMENDATIONS) return;
      if (!this.next.includes(command)) this.next.push(command);
    }
  }
}

const REGISTER_COMMAND =
  'vibecode session bootstrap --register --agent-mode build --task "<task>" --json';

const SUMMARY_HINT_BY_STATE: Readonly<Record<HandoffOnboardingState, string>> = Object.freeze({
  previous_agent_not_ready:
    'the previous agent must commit/revert, unstage blockers, or heartbeat first — do not continue on its paths yet.',
  previous_agent_ready_after_release:
    'the previous agent has clean active claims/intents to release first — you may register and plan, but do not edit or claim those paths yet.',
  blocked_by_active_claims:
    'a terminated/missing agent still holds active claims — they do not transfer; use explicit housekeeping (dry-run first) before those paths become claimable.',
  blocked_by_conflict:
    'a still-blocking conflict affects this handoff — triage it explicitly; never auto-resolve.',
  stale_coordination_requires_housekeeping:
    'stale coordination state makes continuing noisy — run explicit housekeeping (dry-run first) before claiming.',
  next_agent_stale_or_terminated:
    'your own agent session is stale or terminated — heartbeat a stale agent (never a terminated one) or register a new agent before using this guidance.',
  next_agent_read_only:
    'your agent is read_only — observe and report only; no claim, edit, or commit guidance applies.',
  next_agent_not_registered:
    'register your own agent via session bootstrap first — the previous agent\'s registration and claims are never yours.',
  same_agent_resume:
    'same-agent resume is not a cross-agent handoff — use session_recovery and session bootstrap for this agent; do not run next-agent claim planning from the handoff guide.',
  ready_for_new_agent:
    'the previous agent is ready — bootstrap, then plan and claim the exact files YOU need; nothing is transferred.',
  uncertain_state:
    'state could not be classified safely — inspect only; do not register-and-continue, claim, edit, or commit based on this guide.',
});

const ACTION_BY_STATE: Readonly<Record<HandoffOnboardingState, HandoffOnboardingAction>> = Object.freeze({
  previous_agent_not_ready: 'wait_for_previous_agent',
  previous_agent_ready_after_release: 'wait_for_release',
  blocked_by_active_claims: 'run_housekeeping_dry_run',
  blocked_by_conflict: 'triage_conflict',
  stale_coordination_requires_housekeeping: 'run_housekeeping_dry_run',
  next_agent_stale_or_terminated: 'heartbeat_or_reregister',
  next_agent_read_only: 'observe_read_only',
  next_agent_not_registered: 'register_and_plan',
  same_agent_resume: 'resume_same_agent',
  ready_for_new_agent: 'plan_and_claim_explicitly',
  uncertain_state: 'inspect_only',
});

/**
 * Build the next-agent onboarding guide from an already-built handoff packet.
 * Pure and read-only: inputs are never mutated and nothing is loaded, written,
 * registered, claimed, released, or transferred.
 */
export function buildNextAgentHandoffGuide(
  input: NextAgentHandoffGuideBuildInput,
): NextAgentHandoffGuide {
  const rawMaxItems =
    input.maxItems && input.maxItems > 0 ? input.maxItems : DEFAULT_HANDOFF_GUIDE_ITEMS;
  if (rawMaxItems > HANDOFF_GUIDE_MAX_ITEMS) {
    throw new Error(`max_items ${rawMaxItems} exceeds maximum ${HANDOFF_GUIDE_MAX_ITEMS}`);
  }
  const maxItems = rawMaxItems;
  const warnings: RuntimeNotice[] = [];
  const blockers: RuntimeNotice[] = [];
  const rec = new Recommendations();
  const required: HandoffGuideRequiredAction[] = [];

  const packet = input.packet;
  const fromAgentId = packet.agent_id;
  const sourceState = packet.handoff.handoff_state;

  // --- next agent identity (computed only; the guide never registers/heartbeats) ---
  const forAgent = input.forAgent;
  const forAgentId = input.forAgentId;
  const nextStatus: AgentStatus | null = forAgent?.status ?? null;
  const nextMode = forAgent ? getAgentOperatingMode(forAgent) : null;
  const rawNextTask = forAgent ? getAgentTask(forAgent) : null;
  const nextTaskTruncated =
    rawNextTask !== null && rawNextTask.length > RUNTIME_AWARENESS_TASK_MAX_CHARS;
  const nextTask = rawNextTask === null
    ? null
    : nextTaskTruncated
      ? rawNextTask.slice(0, RUNTIME_AWARENESS_TASK_MAX_CHARS)
      : rawNextTask;
  const sameAgentResume = forAgentId !== null && forAgentId === fromAgentId;

  const sourceTerminatedOrMissing = sourceState === 'terminated_or_missing_agent';
  const stagedBlockers =
    packet.workspace.staged_unclaimed_count + packet.workspace.staged_other_agent_count;
  const previousActiveClaims = packet.owned_work.active_claims_count;
  const previousActiveIntents = packet.owned_work.active_intents_count;

  // --- primary onboarding state (previous-agent side first, then next-agent side, fail safe) ---
  let state: HandoffOnboardingState;
  let nextAgentSideOk = false;
  if (sourceState === 'uncertain_state') {
    state = 'uncertain_state';
  } else if (sourceTerminatedOrMissing) {
    if (stagedBlockers > 0) {
      // Nobody owns the staged blockers and the previous agent cannot act —
      // fail closed instead of inviting the next agent into an unsafe index.
      state = 'uncertain_state';
    } else if (previousActiveClaims > 0) {
      state = 'blocked_by_active_claims';
    } else if (packet.coordination.stale_coordination_present) {
      state = 'stale_coordination_requires_housekeeping';
    } else {
      nextAgentSideOk = true;
      state = 'ready_for_new_agent'; // refined by the next-agent checks below
    }
  } else if (
    sourceState === 'stale_agent_needs_heartbeat' ||
    sourceState === 'blocked_by_staged_files' ||
    sourceState === 'commit_before_handoff' ||
    sourceState === 'isolated_commit_before_handoff'
  ) {
    state = 'previous_agent_not_ready';
  } else if (sourceState === 'blocked_by_conflict') {
    state = 'blocked_by_conflict';
  } else if (sourceState === 'ready_after_release') {
    state = 'previous_agent_ready_after_release';
  } else {
    // ready_to_handoff or read_only_report: the previous agent side is clear.
    nextAgentSideOk = true;
    state = 'ready_for_new_agent';
  }

  if (sameAgentResume) {
    state = 'same_agent_resume';
    nextAgentSideOk = false;
  }

  if (nextAgentSideOk) {
    if (forAgent === null) {
      state = 'next_agent_not_registered';
    } else if (nextStatus === 'terminated' || nextStatus === 'stale' || nextStatus === 'unknown') {
      state = 'next_agent_stale_or_terminated';
    } else if (nextMode === null || rawNextTask === null) {
      // Registered but invalid session metadata: re-register before continuing.
      state = 'next_agent_not_registered';
    } else if (nextMode === 'read_only') {
      state = 'next_agent_read_only';
    } else {
      state = 'ready_for_new_agent';
    }
  }

  // --- warnings about the previous agent that never compete with the primary state ---
  if (sourceTerminatedOrMissing) {
    warnings.push(
      notice(
        'PREVIOUS_AGENT_UNAVAILABLE',
        'warning',
        `Previous agent ${fromAgentId} is terminated or not registered. Its claims never transfer; leftover state is coordination housekeeping, not authorization.`,
      ),
    );
  }
  if (input.forAgentRequested && forAgent === null && forAgentId !== null) {
    warnings.push(
      notice(
        'NEXT_AGENT_NOT_FOUND',
        'warning',
        `for_agent_id ${forAgentId} is not a registered agent. Register your own agent via session bootstrap before continuing.`,
      ),
    );
  }
  if (sameAgentResume) {
    warnings.push(
      notice(
        'SAME_AGENT_RESUME',
        'warning',
        `for_agent_id equals from_agent_id (${fromAgentId}): this is a same-agent resume, not a cross-agent handoff. Use the session_recovery profile and session bootstrap instead of onboarding as a new agent.`,
      ),
    );
    rec.tool('vibecode_session_bootstrap');
    rec.nextCommand(
      'vibecode tools profile --profile session_recovery --json',
      `vibecode session bootstrap --agent ${fromAgentId} --json`,
    );
  }

  // --- per-state required actions, notices, and SEPARATED command lists ---
  switch (state) {
    case 'previous_agent_not_ready': {
      blockers.push(
        notice(
          'PREVIOUS_AGENT_NOT_READY',
          'block',
          `Previous agent ${fromAgentId} is not ready to hand off (${sourceState}). Do not edit or claim its paths until its prerequisites are satisfied and handoff prepare reports ready.`,
        ),
      );
      if (sourceState === 'stale_agent_needs_heartbeat') {
        required.push('previous_agent_heartbeat_and_rerun_prepare');
        rec.tool('vibecode_agent_heartbeat', 'vibecode_handoff_prepare');
        rec.previousCommand(
          `vibecode agents heartbeat --agent ${fromAgentId} --json`,
          `vibecode handoff prepare --agent ${fromAgentId} --json`,
        );
      } else if (sourceState === 'blocked_by_staged_files') {
        required.push('inspect_staged_blockers');
        rec.tool('vibecode_git_changes', 'vibecode_finalize_check');
        rec.previousCommand(
          `vibecode git changes --agent ${fromAgentId} --json`,
          `vibecode finalize check --agent ${fromAgentId} --json`,
        );
      } else {
        required.push('previous_agent_commit_or_revert');
        rec.tool('vibecode_git_changes', 'vibecode_finalize_check');
        rec.previousCommand(
          `vibecode git changes --agent ${fromAgentId} --json`,
          `vibecode finalize check --agent ${fromAgentId} --json`,
          `vibecode commit guard --agent ${fromAgentId} --dry-run --json`,
        );
      }
      rec.tool('vibecode_handoff_prepare');
      break;
    }
    case 'previous_agent_ready_after_release': {
      warnings.push(
        notice(
          'WAIT_FOR_RELEASE',
          'warning',
          `Previous agent ${fromAgentId} still owns ${previousActiveClaims} active claim(s) / ${previousActiveIntents} active intent(s). Wait for it to release them; you may register and plan, but do not edit or claim those paths yet.`,
        ),
      );
      if (previousActiveIntents > 0) {
        required.push('previous_agent_release_intents');
        rec.tool('vibecode_claim_intents_list', 'vibecode_claim_intent_release');
        rec.previousCommand(
          `vibecode claims intents list --agent ${fromAgentId} --status active --json`,
          `vibecode claims intent-release --agent ${fromAgentId} --intent-id <intent_id> --dry-run --json`,
          `vibecode claims intent-release --agent ${fromAgentId} --intent-id <intent_id> --json`,
        );
      } else {
        required.push('previous_agent_release_claims');
        rec.tool('vibecode_claims_list', 'vibecode_claim_release');
        rec.previousCommand(
          `vibecode claims list --agent ${fromAgentId} --json`,
          'vibecode claims release --claim <claim_id> --json',
        );
      }
      break;
    }
    case 'blocked_by_active_claims': {
      required.push('run_coordination_housekeeping_dry_run');
      blockers.push(
        notice(
          'ACTIVE_CLAIMS_DO_NOT_TRANSFER',
          'block',
          `${previousActiveClaims} active claim(s) of terminated/missing agent ${fromAgentId} still exist. They never transfer to you — use explicit housekeeping (dry-run first) and claim the files yourself afterwards.`,
        ),
      );
      rec.tool('vibecode_claims_list', 'vibecode_claims_reap');
      rec.nextCommand(
        'vibecode tools profile --profile coordination_housekeeping --json',
        'vibecode claims reap --dry-run --json',
      );
      break;
    }
    case 'blocked_by_conflict': {
      required.push('triage_blocking_conflict');
      blockers.push(
        notice(
          'CONFLICT_BLOCKS_ONBOARDING',
          'block',
          'A still-blocking conflict involves this handoff. Triage it explicitly before continuing; resolution is never automatic.',
        ),
      );
      rec.tool('vibecode_conflicts_list', 'vibecode_conflict_detail');
      rec.nextCommand(
        'vibecode tools profile --profile conflict_resolution --json',
        'vibecode conflicts list --json',
      );
      break;
    }
    case 'stale_coordination_requires_housekeeping': {
      required.push('run_coordination_housekeeping_dry_run');
      warnings.push(
        notice(
          'STALE_COORDINATION_PRESENT',
          'warning',
          'Stale coordination state (stale agents/claims/intents) makes continuing noisy. Run explicit housekeeping (dry-run first) before claiming; never force-clean.',
        ),
      );
      rec.tool('vibecode_claims_list', 'vibecode_claims_reap');
      rec.nextCommand(
        'vibecode tools profile --profile coordination_housekeeping --json',
        'vibecode claims reap --dry-run --json',
      );
      break;
    }
    case 'next_agent_stale_or_terminated': {
      required.push('heartbeat_or_reregister_next_agent');
      warnings.push(
        notice(
          'NEXT_AGENT_STALE_OR_TERMINATED',
          'high',
          nextStatus === 'terminated'
            ? `Your agent ${forAgentId} is terminated — register a NEW agent; never heartbeat or reuse a terminated agent.`
            : `Your agent ${forAgentId} is ${nextStatus} — heartbeat it and re-run session bootstrap before using this guidance.`,
        ),
      );
      if (nextStatus === 'terminated') {
        rec.tool('vibecode_session_bootstrap');
        rec.nextCommand(REGISTER_COMMAND);
      } else {
        rec.tool('vibecode_agent_heartbeat', 'vibecode_session_bootstrap');
        rec.nextCommand(
          `vibecode agents heartbeat --agent ${forAgentId} --json`,
          `vibecode session bootstrap --agent ${forAgentId} --json`,
        );
      }
      break;
    }
    case 'next_agent_read_only': {
      warnings.push(
        notice(
          'NEXT_AGENT_READ_ONLY',
          'info',
          `Your agent ${forAgentId} is read_only: use this guide for observation and reporting only — no claim, edit, finalize, or commit.`,
        ),
      );
      rec.tool('vibecode_workspace_info', 'vibecode_project_instructions');
      rec.nextCommand('vibecode tools profile --profile read_only_orientation --json');
      break;
    }
    case 'next_agent_not_registered': {
      required.push('register_next_agent');
      rec.tool('vibecode_session_bootstrap', 'vibecode_tool_profile');
      rec.nextCommand(
        REGISTER_COMMAND,
        'vibecode tools profile --profile team_handoff --json',
      );
      break;
    }
    case 'same_agent_resume': {
      required.push('resume_same_agent_with_session_recovery');
      rec.tool('vibecode_session_bootstrap', 'vibecode_tool_profile');
      rec.nextCommand(
        'vibecode tools profile --profile session_recovery --json',
        `vibecode session bootstrap --agent ${fromAgentId} --json`,
        'vibecode tools profile --profile runtime_preflight --json',
      );
      break;
    }
    case 'ready_for_new_agent': {
      required.push('plan_and_claim_explicit_files');
      rec.tool('vibecode_session_bootstrap', 'vibecode_tool_profile', 'vibecode_claims_plan');
      rec.nextCommand(
        `vibecode session bootstrap --agent ${forAgentId} --json`,
        'vibecode tools profile --profile build_pre_edit --json',
        `vibecode claims plan --agent ${forAgentId} --intent "<intent>" --path <path> --json`,
      );
      break;
    }
    case 'uncertain_state': {
      required.push('inspect_only');
      blockers.push(
        notice(
          'UNCERTAIN_ONBOARDING_STATE',
          'block',
          'Handoff/onboarding state could not be classified safely (git unavailable, invalid session data, or unowned staged files). Inspect only — do not claim, edit, commit, release, or clean up based on this guide.',
        ),
      );
      rec.tool('vibecode_session_bootstrap', 'vibecode_git_changes');
      rec.nextCommand('vibecode session bootstrap --json');
      break;
    }
  }

  // --- secondary notices (never compete with the primary state) ---
  if (
    packet.coordination.stale_coordination_present &&
    state !== 'stale_coordination_requires_housekeeping' &&
    state !== 'uncertain_state'
  ) {
    warnings.push(
      notice(
        'STALE_COORDINATION_PRESENT',
        'warning',
        'Stale coordination state (stale agents/claims/intents) exists. Housekeeping is explicit and dry-run-first; never release another agent\'s intent.',
      ),
    );
    rec.tool('vibecode_claims_reap');
    rec.nextCommand(
      'vibecode tools profile --profile coordination_housekeeping --json',
      'vibecode claims reap --dry-run --json',
    );
  }
  if (
    packet.workspace.unclaimed_dirty_count > 0 &&
    state !== 'previous_agent_not_ready' &&
    state !== 'uncertain_state'
  ) {
    warnings.push(
      notice(
        'UNCLAIMED_DIRTY_FILES_PRESENT',
        'warning',
        `${packet.workspace.unclaimed_dirty_count} unclaimed dirty file(s) exist in the shared tree — ownership is unclear and onboarding does not make them safe. Inspect shared-tree state (vibecode git changes) before editing anything.`,
      ),
    );
  }

  // --- bounded path samples (always from the packet, never inferred) ---
  const ownedSamples = packet.owned_work.sample_claimed_paths.slice(0, maxItems);
  const pathsTruncated =
    ownedSamples.length < previousActiveClaims ||
    packet.owned_work.samples_truncated;
  const blockedPaths = previousActiveClaims > 0 ? ownedSamples : [];

  const canContinueNow = state === 'ready_for_new_agent';
  const canRegisterAndPlan =
    state === 'ready_for_new_agent' ||
    state === 'next_agent_not_registered' ||
    state === 'previous_agent_not_ready' ||
    state === 'previous_agent_ready_after_release' ||
    state === 'blocked_by_active_claims' ||
    state === 'blocked_by_conflict' ||
    state === 'stale_coordination_requires_housekeeping';

  return {
    from_agent_id: fromAgentId,
    for_agent_id: forAgentId,
    handoff_source: {
      handoff_state: sourceState,
      handoff_ready: packet.handoff.handoff_ready,
      summary: packet.handoff.summary,
      requires_current_agent_action: packet.handoff.requires_current_agent_action,
      required_before_handoff: [...packet.handoff.required_before_handoff],
      active_claims_count: previousActiveClaims,
      active_intents_count: previousActiveIntents,
      dirty_claimed_files_count: packet.owned_work.dirty_claimed_files_count,
    },
    next_agent: {
      requested: input.forAgentRequested,
      registered: forAgent !== null,
      status: nextStatus,
      operating_mode: nextMode,
      task: nextTask,
      task_truncated: nextTaskTruncated,
    },
    onboarding: {
      onboarding_state: state,
      summary: `${state} — ${SUMMARY_HINT_BY_STATE[state]}`,
      recommended_action: ACTION_BY_STATE[state],
      can_continue_now: canContinueNow,
      can_register_and_plan: canRegisterAndPlan,
      must_claim_explicitly: true,
      ownership_transferred: false,
      same_agent_resume: sameAgentResume,
    },
    blocked_paths: blockedPaths,
    paths_requiring_new_claim_after_release: blockedPaths,
    paths_truncated: pathsTruncated,
    path_guidance: [...HANDOFF_GUIDE_PATH_GUIDANCE],
    required_before_continue: required,
    safe_next_tools: rec.tools,
    previous_agent_cli_commands: rec.previous,
    next_agent_cli_commands: rec.next,
    do_not_do: [...HANDOFF_GUIDE_DO_NOT_DO],
    warnings,
    blockers,
    checked_at: input.now,
  };
}

export interface GetNextAgentHandoffGuideOptions {
  from_agent_id: string;
  for_agent_id?: string;
  max_items?: number;
  /** Clock seam (ISO-8601). */
  now?: string;
  /** Test seam: read-only git runner. */
  gitRunner?: GitReadOnlyRunner;
}

/**
 * Load the previous agent's handoff packet plus the next agent's session and
 * build the onboarding guide. Strictly read-only: no register, no heartbeat,
 * no claim/intent/conflict mutation, no git mutation — only the same read-only
 * listings the handoff packet loader uses.
 */
export function getNextAgentHandoffGuide(
  repoRoot: string,
  options: GetNextAgentHandoffGuideOptions,
): NextAgentHandoffGuide {
  const now = options.now ?? new Date().toISOString();
  const packet = getAgentHandoffPacket(repoRoot, {
    agent_id: options.from_agent_id,
    max_items: options.max_items,
    now,
    gitRunner: options.gitRunner,
  });

  const forAgentRequested = options.for_agent_id !== undefined;
  const forAgentId = options.for_agent_id ?? null;
  const forAgent = forAgentRequested
    ? listAgents(repoRoot, { now }).find((a) => a.agent_id === forAgentId) ?? null
    : null;

  return buildNextAgentHandoffGuide({
    packet,
    forAgentRequested,
    forAgentId,
    forAgent,
    maxItems: options.max_items,
    now,
  });
}
