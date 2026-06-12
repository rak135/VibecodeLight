import type {
  AgentRuntimeAwareness,
  RuntimeNotice,
} from './runtime_awareness.js';

/**
 * Phase 3C — session continuity / safe resume guidance (read-only, pure).
 *
 * When an agent comes back after an interruption (model crash, MCP restart,
 * long test run, stale heartbeat, half-finished workflow) it must answer one
 * question before touching anything: "what state am I in, and what is the one
 * safe next step?". This module classifies the already-computed runtime
 * awareness into a single primary `resume_state` plus explicit flags and exact
 * safe commands. Secondary conditions (stale coordination, a conflict that does
 * not block the primary action, an overdue heartbeat) surface as notices, never
 * as competing primary states.
 *
 * Hard rules (mirror — never weaken — the real policies):
 *   - pure function over the awareness data; no filesystem, no git, no writes,
 *     no heartbeat/claim/release/reap/resolve mutation, no auto-anything;
 *   - Vibecode never decides what the agent works on, never recovers/transfers/
 *     cleans state secretly: every recommendation is an explicit command the
 *     agent (or human) runs itself;
 *   - released or stale claims never authorize resuming an edit — the agent
 *     re-plans and re-claims;
 *   - terminated/missing agents are never heartbeat or reused — register new;
 *   - unclaimed dirty files are never called safe; staged unclaimed files block;
 *   - ambiguous/unknown state fails safe (`uncertain_state`): inspect-only
 *     guidance, never commit/release/cleanup;
 *   - the MCP stale-server guidance is static: core cannot reliably know the
 *     "expected" tool count, so it never asserts a mismatch (no false-positive
 *     stale warnings) — it only teaches the comparison and the CLI fallback.
 */

/** Ordered canonical resume states (most blocking lifecycle states first). */
export const AGENT_RESUME_STATES = [
  'not_registered',
  'terminated',
  'stale_needs_heartbeat',
  'read_only_observe_only',
  'ready_to_claim',
  'ready_to_continue',
  'ready_to_commit',
  'isolated_commit_possible',
  'blocked_by_staged_unclaimed',
  'ready_to_release',
  'blocked_by_conflict',
  'uncertain_state',
] as const;

export type AgentResumeState = (typeof AGENT_RESUME_STATES)[number];

export type RecoveryConfidence = 'high' | 'medium' | 'low';

/** Short machine-readable primary action token per resume state. */
export const RECOVERY_RESUME_ACTIONS = [
  'register_new_agent',
  'heartbeat_then_rebootstrap',
  'observe_read_only',
  'plan_and_claim',
  'continue_work',
  'commit_via_guard',
  'dry_run_isolated_commit',
  'inspect_staged_unclaimed',
  'release_clean_intent',
  'triage_conflict',
  'rebootstrap_and_inspect',
] as const;

export type RecoveryResumeAction = (typeof RECOVERY_RESUME_ACTIONS)[number];

/** Hard cap on each recovery recommendation list (matches runtime awareness). */
export const RECOVERY_MAX_RECOMMENDATIONS = 12;

/** Compact resume/recovery guidance embedded in `runtime_awareness.recovery`. */
export interface AgentRecoveryGuidance {
  resume_state: AgentResumeState;
  confidence: RecoveryConfidence;
  /** One bounded line: `<resume_state> — <what to do>`. Used for human output. */
  summary: string;
  recommended_resume_action: RecoveryResumeAction;
  can_continue_existing_agent: boolean;
  requires_new_agent: boolean;
  requires_heartbeat: boolean;
  requires_rebootstrap: boolean;
  has_active_claims: boolean;
  has_active_intents: boolean;
  has_dirty_claimed_files: boolean;
  has_releasable_clean_intents: boolean;
  has_unclaimed_dirty_files: boolean;
  has_staged_blockers: boolean;
  recommended_next_tools: string[];
  recommended_cli_commands: string[];
  /**
   * Static stale-MCP-server guidance (Part C). Deterministic text only: the
   * core cannot reliably know the expected tool count, so it never asserts a
   * live mismatch — it teaches the comparison and the CLI fallback instead.
   */
  mcp_stale_guidance: string[];
  warnings: RuntimeNotice[];
  blockers: RuntimeNotice[];
}

/** The awareness data the classifier consumes (everything except itself). */
export type RecoveryAwareness = Omit<AgentRuntimeAwareness, 'recovery'>;

export interface AgentRecoveryGuidanceInput {
  awareness: RecoveryAwareness;
  /** Count of the agent's own ACTIVE claims (dirty or clean; never released). */
  activeClaimsCount: number;
}

const REGISTER_COMMAND =
  'vibecode session bootstrap --register --agent-mode <read_only|build> --task "<task>" --json';

/** Placeholder-bearing commands are examples to fill in, never to run blindly. */
const MCP_STALE_GUIDANCE: readonly string[] = Object.freeze([
  'If an expected vibecode_* MCP tool is missing, or runtime_awareness.server.tool_count differs from the current build (`vibecode mcp tools --json`), the MCP server session is stale: restart/reconnect the MCP server.',
  'All recovery commands here are CLI commands — use the Vibecode CLI as the fallback while the MCP server is stale or unavailable.',
]);

function notice(code: string, severity: RuntimeNotice['severity'], message: string): RuntimeNotice {
  return { code, severity, message };
}

/** Bounded, deduped recommendation builder. */
class Recommendations {
  readonly tools: string[] = [];
  readonly commands: string[] = [];

  tool(...names: string[]): void {
    for (const name of names) {
      if (this.tools.length >= RECOVERY_MAX_RECOMMENDATIONS) return;
      if (!this.tools.includes(name)) this.tools.push(name);
    }
  }

  command(...commands: string[]): void {
    for (const command of commands) {
      if (this.commands.length >= RECOVERY_MAX_RECOMMENDATIONS) return;
      if (!this.commands.includes(command)) this.commands.push(command);
    }
  }
}

const RESUME_ACTION_BY_STATE: Readonly<Record<AgentResumeState, RecoveryResumeAction>> = Object.freeze({
  not_registered: 'register_new_agent',
  terminated: 'register_new_agent',
  stale_needs_heartbeat: 'heartbeat_then_rebootstrap',
  read_only_observe_only: 'observe_read_only',
  ready_to_claim: 'plan_and_claim',
  ready_to_continue: 'continue_work',
  ready_to_commit: 'commit_via_guard',
  isolated_commit_possible: 'dry_run_isolated_commit',
  blocked_by_staged_unclaimed: 'inspect_staged_unclaimed',
  ready_to_release: 'release_clean_intent',
  blocked_by_conflict: 'triage_conflict',
  uncertain_state: 'rebootstrap_and_inspect',
});

const SUMMARY_HINT_BY_STATE: Readonly<Record<AgentResumeState, string>> = Object.freeze({
  not_registered: 'register a new agent via session bootstrap; old or released claims grant nothing.',
  terminated: 'this agent is terminated — register a new agent; never heartbeat it or reuse its old claims.',
  stale_needs_heartbeat: 'heartbeat your agent, then re-run session bootstrap before continuing.',
  read_only_observe_only: 'read-only session — observe only; no claim, edit, finalize, or commit.',
  ready_to_claim: 'no active claims/intents — plan and claim explicit files before editing.',
  ready_to_continue: 'your claims/intents are still active — continue; run git changes before further edits.',
  ready_to_commit: 'run git changes, finalize check, then commit guard dry-run.',
  isolated_commit_possible: 'commit guard dry-run may make an ISOLATED commit of your claimed files; unclaimed dirty files are skipped, not made safe.',
  blocked_by_staged_unclaimed: 'unclaimed file(s) are STAGED — inspect and unstage them yourself before any commit.',
  ready_to_release: 'your clean work intent is releasable — dry-run intent-release first, then release.',
  blocked_by_conflict: 'a conflict involving this agent is still blocking — triage it; never auto-resolve.',
  uncertain_state: 'state could not be classified safely — re-run session bootstrap and git changes; do not commit, release, or clean up.',
});

/**
 * Classify the primary resume state and build the safe resume guidance. Pure
 * and read-only: consumes the already-computed awareness, mutates nothing.
 */
export function getAgentRecoveryGuidance(input: AgentRecoveryGuidanceInput): AgentRecoveryGuidance {
  const a = input.awareness;
  const warnings: RuntimeNotice[] = [];
  const blockers: RuntimeNotice[] = [];
  const rec = new Recommendations();

  const agentId = a.agent.agent_id;
  const registered = a.agent.registered;
  const status = a.agent.status;
  const mode = a.agent.operating_mode;
  const counts = a.workspace.changed_counts;
  const gitAvailable = a.workspace.git_available;
  const invalidSession = a.blockers.some((b) => b.code === 'INVALID_AGENT_SESSION');
  const stillBlockingConflicts = a.coordination.still_blocking_conflicts_involving_agent_count;

  const hasActiveClaims = input.activeClaimsCount > 0;
  const hasActiveIntents = a.coordination.active_intents_count > 0;
  const hasDirtyClaimedFiles = gitAvailable && counts.claimed_by_agent > 0;
  const hasReleasableCleanIntents = a.coordination.releasable_intents_count > 0;
  const hasUnclaimedDirtyFiles = gitAvailable && counts.unclaimed + counts.stale_claim_overlap > 0;
  const hasStagedBlockers = gitAvailable && counts.staged_unclaimed > 0;

  // --- primary state classification (lifecycle first, then workspace) ---
  let state: AgentResumeState;
  if (!registered) {
    state = 'not_registered';
  } else if (status === 'terminated') {
    state = 'terminated';
  } else if (invalidSession) {
    state = 'uncertain_state';
  } else if (status === 'stale' || status === 'unknown') {
    state = 'stale_needs_heartbeat';
  } else if (mode === 'read_only') {
    state = 'read_only_observe_only';
  } else if (!gitAvailable) {
    state = 'uncertain_state';
  } else if (hasStagedBlockers) {
    state = 'blocked_by_staged_unclaimed';
  } else if (a.commit_guard.commit_guard_ready) {
    state = 'ready_to_commit';
  } else if (a.commit_guard.isolated_commit_possible) {
    state = 'isolated_commit_possible';
  } else if (stillBlockingConflicts > 0) {
    state = 'blocked_by_conflict';
  } else if (hasReleasableCleanIntents) {
    state = 'ready_to_release';
  } else if (hasActiveClaims || hasActiveIntents) {
    state = 'ready_to_continue';
  } else {
    state = 'ready_to_claim';
  }

  // --- lifecycle flags ---
  const canContinue =
    registered && status !== 'terminated' && !invalidSession;
  const requiresNewAgent = !registered || status === 'terminated' || invalidSession;
  const requiresHeartbeat =
    canContinue && (state === 'stale_needs_heartbeat' || a.agent.needs_heartbeat);
  const requiresRebootstrap = state === 'stale_needs_heartbeat' || state === 'uncertain_state';

  // --- per-state primary recommendations (real, safe commands only) ---
  switch (state) {
    case 'not_registered':
      if (agentId) {
        blockers.push(
          notice(
            'AGENT_NOT_FOUND',
            'block',
            `agent_id ${agentId} is not a registered agent. Register a new agent; its old claims do not authorize any edit.`,
          ),
        );
      }
      rec.tool('vibecode_session_start');
      rec.command(REGISTER_COMMAND);
      break;
    case 'terminated':
      blockers.push(
        notice(
          'AGENT_TERMINATED',
          'block',
          `Agent ${agentId} is terminated. Register a new agent; never heartbeat a terminated agent or reuse its old claims.`,
        ),
      );
      rec.tool('vibecode_session_start');
      rec.command(REGISTER_COMMAND);
      break;
    case 'stale_needs_heartbeat':
      rec.tool('vibecode_session_start');
      rec.command(
        `vibecode agents heartbeat --agent ${agentId} --json`,
        `vibecode session bootstrap --agent ${agentId} --json`,
      );
      break;
    case 'read_only_observe_only':
      rec.tool('vibecode_workspace_snapshot', 'vibecode_project_instructions');
      rec.command('vibecode tools profile --profile read_only_orientation --json');
      break;
    case 'ready_to_claim':
      rec.tool('vibecode_workspace_snapshot', 'vibecode_build_start');
      rec.command(
        'vibecode tools profile --profile build_pre_edit --json',
        `vibecode claims plan --agent ${agentId} --intent "<intent>" --path <path> --json`,
      );
      break;
    case 'ready_to_continue':
      rec.tool('vibecode_changes', 'vibecode_build_scope');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode claims intents list --agent ${agentId} --status active --json`,
      );
      break;
    case 'ready_to_commit':
    case 'isolated_commit_possible':
      rec.tool('vibecode_changes', 'vibecode_build_finish');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode finalize check --agent ${agentId} --json`,
        `vibecode commit guard --agent ${agentId} --dry-run --json`,
      );
      break;
    case 'blocked_by_staged_unclaimed':
      blockers.push(
        notice(
          'STAGED_UNCLAIMED_FILES_BLOCKED',
          'block',
          `${counts.staged_unclaimed} unclaimed dirty file(s) are STAGED in the git index. Inspect and unstage them yourself before any commit — the guard blocks and never auto-unstages; never commit them.`,
        ),
      );
      rec.tool('vibecode_changes', 'vibecode_build_finish');
      rec.command(
        `vibecode git changes --agent ${agentId} --json`,
        `vibecode finalize check --agent ${agentId} --json`,
      );
      break;
    case 'ready_to_release':
      rec.tool('vibecode_build_scope');
      rec.command(
        `vibecode claims intents list --agent ${agentId} --status active --json`,
        `vibecode claims intent-release --agent ${agentId} --intent-id <intent_id> --dry-run --json`,
      );
      break;
    case 'blocked_by_conflict':
      rec.tool('vibecode_workspace_snapshot');
      rec.command(
        'vibecode tools profile --profile conflict_resolution --json',
        'vibecode conflicts list --json',
      );
      break;
    case 'uncertain_state':
      rec.tool('vibecode_session_start', 'vibecode_changes');
      if (canContinue && agentId) {
        rec.command(
          `vibecode session bootstrap --agent ${agentId} --json`,
          `vibecode git changes --agent ${agentId} --json`,
        );
      } else {
        rec.command(REGISTER_COMMAND);
      }
      break;
  }

  // --- secondary notices (never compete with the primary state) ---
  if (requiresHeartbeat && state !== 'stale_needs_heartbeat') {
    warnings.push(
      notice(
        'HEARTBEAT_RECOMMENDED',
        'warning',
        `Agent ${agentId} has not heartbeat for over half the TTL. Heartbeat before/while continuing so the session does not go stale.`,
      ),
    );
    rec.tool('vibecode_session_start');
    rec.command(`vibecode agents heartbeat --agent ${agentId} --json`);
  }
  if (stillBlockingConflicts > 0 && state !== 'blocked_by_conflict') {
    warnings.push(
      notice(
        'CONFLICTS_STILL_BLOCKING',
        'warning',
        `${stillBlockingConflicts} unresolved conflict(s) involving this agent are still blocking. Triage them after the primary action; never auto-resolve.`,
      ),
    );
    rec.tool('vibecode_workspace_snapshot');
    rec.command('vibecode conflicts list --json');
  }
  if (
    hasUnclaimedDirtyFiles &&
    (state === 'ready_to_claim' || state === 'ready_to_continue')
  ) {
    warnings.push(
      notice(
        'UNCLAIMED_DIRTY_FILES_PRESENT',
        'warning',
        `${counts.unclaimed + counts.stale_claim_overlap} unclaimed dirty file(s) exist — ownership is unclear. Do not edit, stage, or commit them.`,
      ),
    );
  }
  if (state === 'isolated_commit_possible') {
    warnings.push(
      notice(
        'ISOLATED_COMMIT_LIKELY',
        'warning',
        `Finalize is blocked by unclaimed dirty file(s), but the commit guard can likely make an ISOLATED commit of your ${counts.claimed_by_agent} claimed file(s). Skipped unclaimed files stay dirty and untouched — they are never made safe. Inspect the dry-run warnings first.`,
      ),
    );
  }
  if (a.coordination.stale_coordination_present) {
    warnings.push(
      notice(
        'STALE_COORDINATION_PRESENT',
        'warning',
        'Stale coordination state (stale agents/claims/intents) exists. Housekeeping is explicit and dry-run-first; never release another agent\'s intent.',
      ),
    );
    rec.tool('vibecode_build_scope');
    rec.command(
      'vibecode tools profile --profile coordination_housekeeping --json',
      'vibecode claims reap --dry-run --json',
    );
  }

  const confidence: RecoveryConfidence =
    state === 'uncertain_state' ? 'low' : state === 'isolated_commit_possible' ? 'medium' : 'high';

  return {
    resume_state: state,
    confidence,
    summary: `${state} — ${SUMMARY_HINT_BY_STATE[state]}`,
    recommended_resume_action: RESUME_ACTION_BY_STATE[state],
    can_continue_existing_agent: canContinue,
    requires_new_agent: requiresNewAgent,
    requires_heartbeat: requiresHeartbeat,
    requires_rebootstrap: requiresRebootstrap,
    has_active_claims: hasActiveClaims,
    has_active_intents: hasActiveIntents,
    has_dirty_claimed_files: hasDirtyClaimedFiles,
    has_releasable_clean_intents: hasReleasableCleanIntents,
    has_unclaimed_dirty_files: hasUnclaimedDirtyFiles,
    has_staged_blockers: hasStagedBlockers,
    recommended_next_tools: rec.tools,
    recommended_cli_commands: rec.commands,
    mcp_stale_guidance: [...MCP_STALE_GUIDANCE],
    warnings,
    blockers,
  };
}
