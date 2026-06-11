import fs from 'fs';
import path from 'path';

import {
  getCodeGraphStatus,
  type CodeGraphStatusResult,
} from '../../adapters/codegraph/codegraph_actions.js';
import { resolveCodeGraphBinary } from '../../adapters/codegraph/codegraph_binary_resolver.js';
import { LlmAdapterError } from '../../adapters/llm/errors.js';
import {
  listAgents,
  heartbeatAgent,
  registerAgent,
} from '../coordination/agents.js';
import {
  isAgentOperatingMode,
  validateExistingAgentMode,
  validateModeImmutability,
  getAgentOperatingMode,
  getAgentTask,
  type AgentOperatingMode,
} from '../coordination/agent_operating_mode.js';
import { listFileClaims } from '../coordination/claims.js';
import { listClaimIntents } from '../coordination/bulk_claims.js';
import {
  summarizeActiveWorkIntents,
  type ActiveWorkIntentSummary,
} from '../coordination/claim_intents.js';
import { listConflicts, type ConflictRecord } from '../coordination/conflicts.js';
import {
  summarizeStaleCoordination,
  type StaleCoordinationSummary,
} from '../coordination/stale_coordination.js';
import {
  listConflictTriages,
} from '../coordination/conflict_triage.js';
import {
  recommendBootstrapToolProfiles,
  type ToolProfileRecommendation,
} from '../agent_guidance/tool_profiles.js';
import {
  getAgentRuntimeAwareness,
  type AgentRuntimeAwareness,
} from './runtime_awareness.js';
import { getCoordinationStatus } from '../coordination/status.js';
import { isAgentType, type AgentSession } from '../coordination/types.js';
import { buildProjectInstructions } from '../runs/project_instructions.js';
import { getRunInfo } from '../runs/run_display.js';
import { resolveExplicitRunDir, resolveRunDir } from '../runs/run_resolver.js';
import {
  defaultGitReadOnlyRunner,
  getReadOnlyGitStatus,
  type GitReadOnlyRunner,
} from '../workspace/git_status.js';
import { getGitChangesSummary } from '../workspace/git_changes_summary.js';

/**
 * Phase 1A — one-call session bootstrap / orientation.
 *
 * Aggregates the read-only orientation a fresh coding agent needs (repo/git
 * state, current run + artifacts, active agents, claims/conflicts, evidence,
 * scan availability, CodeGraph status, a bounded project-instruction excerpt)
 * plus a short agent operating protocol and recommended next tools/commands.
 *
 * It is read-only BY DEFAULT. The only generated state it ever writes is
 * `.vibecode/coordination/state.json`, and only when explicitly asked to
 * register (`register=true`) or heartbeat (an `agent_id` is supplied). It never
 * reads arbitrary source files (the instruction excerpt comes from the same
 * strict allowlist used by `vibecode_project_instructions`) and never mutates
 * git or the working tree.
 *
 * Scope note: in Phase 1A the `scan` section reports availability ONLY. The
 * `scan_summary` view is a later batch.
 */

// Re-export from the shared module for backward compatibility.
export { AGENT_OPERATING_MODES, isAgentOperatingMode } from '../coordination/agent_operating_mode.js';
export type { AgentOperatingMode } from '../coordination/agent_operating_mode.js';

/** The short agent operating protocol returned by every bootstrap call. */
export const AGENT_OPERATING_PROTOCOL: readonly string[] = Object.freeze([
  'Register or confirm your agent identity (read_only or build) with a task/intent before working.',
  'read_only agents must NOT modify source files and do not claim files.',
  'build agents must claim each file (vibecode_claim_add) before editing it.',
  'Inspect the working tree with vibecode_git_changes before editing or finalizing.',
  'Edit only files your agent has claimed.',
  'Run the project checks/tests after editing.',
  'Run vibecode_finalize_check before committing.',
  'Commit only your claimed files through the CLI `vibecode commit guard` (no raw git add/commit).',
  'Heartbeat to stay active; release claims or terminate when done.',
]);

/** Default cap on per-section item lists. */
export const DEFAULT_BOOTSTRAP_MAX_ITEMS = 25;

/**
 * Hard maximum for bootstrap max_items. Core enforces this defensively so that
 * internal callers cannot accidentally request unbounded output. MCP/CLI
 * adapters also enforce it at the validation layer for user-facing rejection.
 */
export const SESSION_BOOTSTRAP_MAX_ITEMS = 100;

/** Default cap on the sample changed-file path preview. */
export const DEFAULT_BOOTSTRAP_SAMPLE_FILES = 10;

/**
 * Phase 2D follow-up: minimum age before an other-agent ACTIVE claim on a
 * CLEAN file is flagged POSSIBLY_STALE_ACTIVE_CLAIMS. A seconds-old claim on a
 * still-clean file is normal "claimed, not yet edited" multi-agent state, not
 * staleness. The grace applies ONLY to this advisory warning: real claim
 * conflicts, dirty/unclaimed safety warnings, and stale-agent TTL semantics
 * are untouched.
 */
export const POSSIBLY_STALE_ACTIVE_CLAIM_MIN_AGE_MS = 2 * 60 * 1000;

/** Max bytes of the bounded project-instruction excerpt. */
export const BOOTSTRAP_INSTRUCTION_EXCERPT_BYTES = 1_200;

export type BootstrapNoticeSeverity = 'info' | 'warning' | 'high' | 'block';

export interface BootstrapNotice {
  code: string;
  severity: BootstrapNoticeSeverity;
  message: string;
}

export interface BootstrapAgentItem {
  agent_id: string;
  name: string;
  type: string;
  status: string;
  last_heartbeat_at?: string;
}

export interface BootstrapAgentIdentity {
  agent_id: string;
  name: string;
  type: string;
  status: string;
  operating_mode: AgentOperatingMode | null;
  task: string | null;
  terminal_session_id: string | null;
}

export interface BootstrapClaimItem {
  claim_id: string;
  path: string;
  mode: string;
  status: string;
  agent_id: string;
  agent_name?: string;
}

export interface BootstrapConflictItem {
  conflict_id: string;
  conflict_type: string;
  severity: string;
  status: string;
  involved_files: string[];
  detected_at: string;
  /** Phase 2D: triage status (still_blocking, stale_blocking, cleared, etc.). */
  triage_status: string;
  /** Phase 2D: blocking agent id, when derivable. */
  blocking_agent_id: string | null;
  /** Phase 2D: blocking agent lifecycle status. */
  blocking_agent_status: string;
  /** Phase 2D: warning codes for the conflict. */
  warning_codes: string[];
}

export interface SessionBootstrapResult {
  ok: boolean;
  repo_root: string;
  /** True when this call wrote generated coordination state (register/heartbeat). */
  generated_state_written: boolean;
  git: {
    available: boolean;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    changed_counts: {
      staged: number;
      unstaged: number;
      untracked: number;
      deleted: number;
      renamed: number;
      generated_or_ignored: number;
      total: number;
    };
    sample_changed_files: string[];
    sample_truncated: boolean;
  };
  current_run: {
    run_ref: string;
    run_id: string | null;
    available: boolean;
    has_final_prompt: boolean;
    has_context_pack: boolean;
    has_flash_output: boolean;
    available_artifacts: string[];
  };
  agents: {
    total: number;
    active: number;
    stale: number;
    terminated: number;
    active_items: BootstrapAgentItem[];
    stale_items: BootstrapAgentItem[];
  };
  current_agent: BootstrapAgentIdentity | null;
  claims: {
    counts: { own: number; other_active: number; stale: number };
    own: BootstrapClaimItem[];
    other_active: BootstrapClaimItem[];
    stale: BootstrapClaimItem[];
  };
  /**
   * Phase 2A: compact summary of the current build agent's active work intents
   * (declared work scopes). Empty for read_only / unregistered agents. Bounded
   * by max_items; full detail lives in coordination state, not here.
   */
  active_work_intents: ActiveWorkIntentSummary[];
  conflicts: {
    unresolved_count: number;
    /** Phase 2D: count of conflicts still actively blocking. */
    still_blocking_count: number;
    /** Phase 2D: count of conflicts with stale/terminated/missing blockers. */
    stale_blocking_count: number;
    /** Phase 2D: count of conflicts no longer blocking (claims released). */
    cleared_count: number;
    items: BootstrapConflictItem[];
  };
  /**
   * Phase 2C: compact, bounded stale-coordination summary (stale agents/claims,
   * active intents with stale/terminated/missing owners or zero active claims)
   * plus the explicit housekeeping commands. Read-only — bootstrap never
   * reaps, releases, or transfers anything.
   */
  stale_coordination: StaleCoordinationSummary;
  evidence: {
    recent_count: number;
    warning_count: number;
    high_count: number;
    last_event_at: string | null;
  };
  scan: {
    /** Phase 1A: availability only — no scan summary in this batch. */
    current_run_scan_available: boolean;
  };
  codegraph: {
    available: boolean;
    initialized: boolean;
    /** Stale-index detection is a later phase; always false in Phase 1A. */
    stale: boolean;
  };
  project_instructions: {
    available: boolean;
    sources: string[];
    excerpt: string | null;
    excerpt_truncated: boolean;
  };
  /**
   * Phase 3B: compact runtime/preflight awareness — lifecycle, heartbeat age,
   * shared-tree commit readiness (finalize vs isolated commit guard), bounded
   * coordination counts, and exact safe next commands. Read-only; `server` is
   * null here and filled only by the MCP adapter (the live server identity).
   */
  runtime_awareness: AgentRuntimeAwareness;
  agent_protocol: string[];
  warnings: BootstrapNotice[];
  blockers: BootstrapNotice[];
  recommended_next_tools: string[];
  recommended_cli_commands: string[];
  /**
   * Phase 1B-3: compact, context-aware tool-profile recommendations (ids +
   * short reasons, NOT full profiles). Fetch a full profile with
   * `vibecode_tool_profile` / `vibecode tools profile`.
   */
  recommended_tool_profiles: ToolProfileRecommendation[];
  checked_at: string;
}

/** Minimal CodeGraph status the bootstrap needs. */
export interface BootstrapCodeGraphStatus {
  available: boolean;
  initialized: boolean;
  version?: string | null;
}

export interface SessionBootstrapInput {
  repoRoot: string;
  agent_id?: string;
  register?: boolean;
  agent_mode?: string;
  agent_name?: string;
  agent_type?: string;
  task?: string;
  terminal_session_id?: string;
  /** Run selection: `current` | `latest` (both = current pointer) | a run id. */
  run_ref?: string;
  max_items?: number;
  include_instructions?: boolean;
  /** Clock seam (ISO-8601). */
  now?: string;
  /** Test seam: read-only git runner. */
  gitRunner?: GitReadOnlyRunner;
  /** Test seam: override CodeGraph status resolution (avoids spawning the binary). */
  codegraphStatus?: (repoRoot: string) => Promise<BootstrapCodeGraphStatus>;
}

function notice(code: string, severity: BootstrapNoticeSeverity, message: string): BootstrapNotice {
  return { code, severity, message };
}

function toAgentItem(agent: AgentSession): BootstrapAgentItem {
  return {
    agent_id: agent.agent_id,
    name: agent.agent_name,
    type: agent.agent_type,
    status: agent.status,
    last_heartbeat_at: agent.last_heartbeat_at,
  };
}

function toIdentity(agent: AgentSession): BootstrapAgentIdentity {
  return {
    agent_id: agent.agent_id,
    name: agent.agent_name,
    type: agent.agent_type,
    status: agent.status,
    operating_mode: getAgentOperatingMode(agent),
    task: getAgentTask(agent),
    terminal_session_id: agent.terminal_session_id,
  };
}

/** Default CodeGraph status provider — mirrors workspace_status, never throws. */
async function defaultCodeGraphStatus(repoRoot: string): Promise<BootstrapCodeGraphStatus> {
  try {
    const binary = resolveCodeGraphBinary({ cliOption: null, env: process.env });
    const status: CodeGraphStatusResult = await getCodeGraphStatus(repoRoot, {
      command: binary.command,
      binary,
    });
    return { available: status.available, initialized: status.initialized, version: status.version ?? null };
  } catch {
    return { available: false, initialized: false, version: null };
  }
}

/** Resolve the requested run selector to a concrete run dir (read-only). */
function resolveRun(
  repoRoot: string,
  runRef: string,
): { runRef: string; runId: string; runDir: string } | null {
  try {
    // `current` and `latest` both resolve to the .vibecode/current pointer in
    // Phase 1A (chronological-latest is intentionally not distinguished yet).
    if (runRef === 'current' || runRef === 'latest') {
      const { runId, runDir } = resolveRunDir(repoRoot, 'latest');
      if (!fs.existsSync(runDir)) return null;
      return { runRef, runId, runDir };
    }
    const { runId, runDir } = resolveExplicitRunDir(repoRoot, runRef);
    if (!fs.existsSync(runDir)) return null;
    return { runRef, runId, runDir };
  } catch (err) {
    if (err instanceof LlmAdapterError) return null;
    return null;
  }
}

function scanAvailable(runDir: string): boolean {
  const scanDir = path.join(runDir, 'scan');
  try {
    return fs.existsSync(scanDir) && fs.readdirSync(scanDir).length > 0;
  } catch {
    return false;
  }
}

interface RegisterResolution {
  agent: AgentSession | null;
  stateWritten: boolean;
  blockers: BootstrapNotice[];
  warnings: BootstrapNotice[];
}

/** Apply the register/heartbeat side-effects (the only generated-state writes). */
function resolveIdentity(input: SessionBootstrapInput, now: string): RegisterResolution {
  const blockers: BootstrapNotice[] = [];
  const warnings: BootstrapNotice[] = [];

  if (input.agent_id) {
    const existing = listAgents(input.repoRoot, { now }).find((a) => a.agent_id === input.agent_id);
    if (!existing) {
      blockers.push(
        notice(
          'AGENT_NOT_FOUND',
          'block',
          `agent_id ${input.agent_id} is not a registered agent. Register a new agent with register=true (agent_mode + task).`,
        ),
      );
      return { agent: null, stateWritten: false, blockers, warnings };
    }
    if (existing.status === 'terminated') {
      blockers.push(
        notice(
          'AGENT_TERMINATED',
          'block',
          `agent_id ${input.agent_id} is terminated. Register a new agent with register=true.`,
        ),
      );
      return { agent: null, stateWritten: false, blockers, warnings };
    }
    // Validate existing agent has required mode/task metadata.
    const modeValidation = validateExistingAgentMode(existing);
    if (modeValidation) {
      blockers.push(notice(modeValidation.code, 'block', modeValidation.message));
      return { agent: null, stateWritten: false, blockers, warnings };
    }
    // Validate mode immutability: if agent_mode is supplied, it must match existing.
    const immutabilityError = validateModeImmutability(
      getAgentOperatingMode(existing),
      input.agent_mode,
    );
    if (immutabilityError) {
      blockers.push(notice('MODE_IMMUTABLE', 'block', immutabilityError));
      return { agent: null, stateWritten: false, blockers, warnings };
    }
    // active / idle / stale → heartbeat (revives stale/idle to active).
    const beat = heartbeatAgent(input.repoRoot, input.agent_id, { now });
    return { agent: beat, stateWritten: true, blockers, warnings };
  }

  if (input.register === true) {
    if (!isAgentOperatingMode(input.agent_mode)) {
      blockers.push(
        notice(
          'INVALID_AGENT_MODE',
          'block',
          `register requires a valid agent_mode (read_only | build); got ${JSON.stringify(input.agent_mode)}.`,
        ),
      );
      return { agent: null, stateWritten: false, blockers, warnings };
    }
    const task = typeof input.task === 'string' ? input.task.trim() : '';
    if (task.length === 0) {
      blockers.push(
        notice('AGENT_TASK_REQUIRED', 'block', 'register requires a non-empty task/intent for both read_only and build agents.'),
      );
      return { agent: null, stateWritten: false, blockers, warnings };
    }
    const agentType = isAgentType(input.agent_type) ? input.agent_type : 'custom';
    const agent = registerAgent(
      input.repoRoot,
      {
        agent_name: input.agent_name && input.agent_name.trim().length > 0 ? input.agent_name : `${agentType} agent`,
        agent_type: agentType,
        terminal_session_id: input.terminal_session_id ?? null,
        metadata: { operating_mode: input.agent_mode, task },
      },
      { now },
    );
    return { agent, stateWritten: true, blockers, warnings };
  }

  // No agent_id and register=false → read-only orientation with a registration
  // warning (the agent must register before it can safely work).
  warnings.push(
    notice(
      'NOT_REGISTERED',
      'high',
      'No agent registered. Register before editing: call session_bootstrap with register=true, a valid agent_mode (read_only | build), and a task/intent.',
    ),
  );
  return { agent: null, stateWritten: false, blockers, warnings };
}

function recommendations(args: {
  registered: boolean;
  hasAgentId: boolean;
  operatingMode: AgentOperatingMode | null;
  hasStaleCleanClaims: boolean;
  hasReleasableIntents: boolean;
  hasStillBlockingConflicts: boolean;
}): { tools: string[]; commands: string[] } {
  const tools: string[] = [];
  const commands: string[] = [];
  if (!args.registered) {
    tools.push('vibecode_session_bootstrap');
    commands.push('vibecode session bootstrap --repo <path> --register --agent-mode <read_only|build> --task "<intent>" --json');
  }
  tools.push('vibecode_git_changes');
  commands.push('vibecode git changes --repo <path> --agent <agent_id> --json');

  if (args.operatingMode === 'build') {
    // Build agents get the claim workflow. Prefer declaring an explicit work
    // scope (plan → add-bulk) over claiming files one-by-one; claim_add remains
    // the single-file fallback.
    tools.push('vibecode_claims_plan', 'vibecode_claims_add_bulk', 'vibecode_claim_add', 'vibecode_finalize_check');
    commands.push(
      'vibecode claims plan --repo <path> --agent <agent_id> --path <path> --json',
      'vibecode claims add-bulk --repo <path> --agent <agent_id> --intent "<intent>" --path <path> --json',
      'vibecode claims add --repo <path> --agent <agent_id> --path <path> --json',
      'vibecode finalize check --repo <path> --agent <agent_id> --json',
    );
    // Phase 2B: recommend intent release when clean releasable intents exist.
    if (args.hasReleasableIntents) {
      tools.push('vibecode_claim_intents_list', 'vibecode_claim_intent_release');
      commands.push(
        'vibecode claims intents list --agent <agent_id> --json',
        'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --dry-run --json',
        'vibecode claims intent-release --agent <agent_id> --intent-id <intent_id> --json',
      );
    }
  } else if (args.operatingMode === 'read_only') {
    // Read-only agents get project-instructions and artifact tools, not claim workflow.
    tools.push('vibecode_project_instructions', 'vibecode_workspace_info');
    commands.push(
      // Phase 3B fix: `vibecode workspace info` does not exist as a CLI
      // command; point at the real read-only orientation profile instead.
      'vibecode tools profile --profile read_only_orientation --json',
    );
  } else {
    // Unknown mode (not registered) — show both for guidance.
    tools.push('vibecode_claim_add', 'vibecode_finalize_check');
    commands.push(
      'vibecode claims add --repo <path> --agent <agent_id> --path <path> --json',
      'vibecode finalize check --repo <path> --agent <agent_id> --json',
    );
  }
  if (args.hasStaleCleanClaims) {
    tools.push('vibecode_claims_list', 'vibecode_claims_reap');
    commands.push(
      'vibecode claims list --repo <repo> --json',
      'vibecode claims reap --repo <repo> --dry-run --json',
    );
  }
  // Phase 2D: conflict triage recommendations.
  if (args.hasStillBlockingConflicts) {
    tools.push('vibecode_conflicts_list', 'vibecode_conflict_detail');
    commands.push(
      'vibecode conflicts list --json',
      'vibecode conflicts detail --conflict-id <conflict_id> --json',
    );
  }
  return { tools, commands };
}

/**
 * Build the one-call session bootstrap result for a repo. Async only because
 * CodeGraph status resolution may spawn the upstream binary; everything else is
 * synchronous read-only aggregation over the shared core services.
 */
export async function getSessionBootstrap(input: SessionBootstrapInput): Promise<SessionBootstrapResult> {
  const checkedAt = input.now ?? new Date().toISOString();
  const repoRoot = input.repoRoot;
  const rawMaxItems = input.max_items && input.max_items > 0 ? input.max_items : DEFAULT_BOOTSTRAP_MAX_ITEMS;
  if (rawMaxItems > SESSION_BOOTSTRAP_MAX_ITEMS) {
    throw new Error(
      `max_items ${rawMaxItems} exceeds maximum ${SESSION_BOOTSTRAP_MAX_ITEMS}`,
    );
  }
  const maxItems = rawMaxItems;
  const runRef = input.run_ref && input.run_ref.trim().length > 0 ? input.run_ref.trim() : 'current';
  const includeInstructions = input.include_instructions !== false;
  const gitRunner = input.gitRunner ?? defaultGitReadOnlyRunner;

  // --- identity (the only generated-state mutation) ---
  const identity = resolveIdentity(input, checkedAt);
  const warnings = [...identity.warnings];
  const blockers = [...identity.blockers];
  const currentAgent = identity.agent;

  // --- git: branch from read-only status; counts/sample from the shared summary ---
  const gitStatus = getReadOnlyGitStatus(repoRoot, gitRunner);
  const changes = getGitChangesSummary(repoRoot, {
    now: checkedAt,
    agent_id: currentAgent?.agent_id,
    includeDiffStat: false,
    maxFiles: DEFAULT_BOOTSTRAP_SAMPLE_FILES,
    gitRunner,
  });
  if (changes.ok) {
    // Surface the claim-aware advisory warnings (unclaimed dirty files, etc.).
    for (const w of changes.warnings) {
      if (w.code === 'NO_AGENT_ID') continue; // already covered by NOT_REGISTERED guidance
      warnings.push(notice(w.code, w.severity === 'info' ? 'info' : w.severity, w.message));
    }
  } else {
    warnings.push(notice('GIT_UNAVAILABLE', 'warning', changes.warnings[0]?.message ?? 'git changed files unavailable'));
  }
  if (changes.ok && changes.dirty && !currentAgent && input.register !== true) {
    warnings.push(notice('DIRTY_WITHOUT_AGENT', 'high', 'The working tree is dirty but no agent is registered. Register before editing/finalizing.'));
  }

  const gitSection: SessionBootstrapResult['git'] = {
    available: changes.ok,
    branch: gitStatus.ok ? gitStatus.branch : null,
    head: changes.ok ? changes.head : gitStatus.ok ? gitStatus.head : null,
    dirty: changes.ok ? changes.dirty : gitStatus.ok ? gitStatus.dirty : false,
    changed_counts: {
      staged: changes.summary.staged,
      unstaged: changes.summary.unstaged,
      untracked: changes.summary.untracked,
      deleted: changes.summary.deleted,
      renamed: changes.summary.renamed,
      generated_or_ignored: changes.summary.generated_or_ignored,
      total: changes.summary.changed_count,
    },
    sample_changed_files: changes.files.map((f) => f.path),
    sample_truncated: changes.truncated,
  };

  // --- current run + artifacts + scan availability ---
  const run = resolveRun(repoRoot, runRef);
  let currentRun: SessionBootstrapResult['current_run'];
  let scanCurrentRunAvailable = false;
  if (run) {
    const info = getRunInfo(run.runDir);
    const availableArtifacts = Object.entries(info.artifacts)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key);
    currentRun = {
      run_ref: run.runRef,
      run_id: run.runId,
      available: true,
      has_final_prompt: Boolean(info.artifacts.final_prompt),
      has_context_pack: Boolean(info.artifacts.context_pack),
      has_flash_output: Boolean(info.artifacts.flash_output),
      available_artifacts: availableArtifacts,
    };
    scanCurrentRunAvailable = scanAvailable(run.runDir);
  } else {
    currentRun = {
      run_ref: runRef,
      run_id: null,
      available: false,
      has_final_prompt: false,
      has_context_pack: false,
      has_flash_output: false,
      available_artifacts: [],
    };
  }

  // --- agents / claims / conflicts / evidence (bounded) ---
  const coordination = getCoordinationStatus(repoRoot, { now: checkedAt });
  const agents = coordination.agents;
  const aliveAgents = agents.filter((a) => a.status === 'active' || a.status === 'idle');
  const staleAgents = agents.filter((a) => a.status === 'stale');
  const agentsSection: SessionBootstrapResult['agents'] = {
    total: agents.length,
    active: aliveAgents.length,
    stale: staleAgents.length,
    terminated: agents.filter((a) => a.status === 'terminated').length,
    active_items: aliveAgents.slice(0, maxItems).map(toAgentItem),
    stale_items: staleAgents.slice(0, maxItems).map(toAgentItem),
  };

  const agentNameById = new Map(agents.map((a) => [a.agent_id, a.agent_name] as const));
  const claims = listFileClaims(repoRoot, { now: checkedAt });
  const toClaimItem = (c: (typeof claims)[number]): BootstrapClaimItem => ({
    claim_id: c.claim_id,
    path: c.path,
    mode: c.mode,
    status: c.status,
    agent_id: c.agent_id,
    agent_name: agentNameById.get(c.agent_id),
  });
  const ownClaims = currentAgent
    ? claims.filter((c) => c.status === 'active' && c.agent_id === currentAgent.agent_id)
    : [];
  const otherActiveClaims = claims.filter(
    (c) => c.status === 'active' && (!currentAgent || c.agent_id !== currentAgent.agent_id),
  );
  const staleClaims = claims.filter((c) => c.status === 'stale');
  const claimsSection: SessionBootstrapResult['claims'] = {
    counts: { own: ownClaims.length, other_active: otherActiveClaims.length, stale: staleClaims.length },
    own: ownClaims.slice(0, maxItems).map(toClaimItem),
    other_active: otherActiveClaims.slice(0, maxItems).map(toClaimItem),
    stale: staleClaims.slice(0, maxItems).map(toClaimItem),
  };

  // --- active work intents (Phase 2A; build agents only, bounded) ---
  const allIntents = listClaimIntents(repoRoot, { now: checkedAt });
  let activeWorkIntents: ActiveWorkIntentSummary[] = [];
  if (currentAgent && getAgentOperatingMode(currentAgent) === 'build') {
    const activeClaimIds = new Set(
      claims.filter((c) => c.status === 'active').map((c) => c.claim_id),
    );
    activeWorkIntents = summarizeActiveWorkIntents({
      intents: allIntents,
      agentId: currentAgent.agent_id,
      activeClaimIds,
      options: { maxItems },
    });
  }

  // --- stale coordination summary (Phase 2C; read-only, bounded) ---
  // Counts cover ALL agents/claims/intents; only the samples are capped. The
  // summary recommends explicit list/reap/heartbeat commands — never an
  // automatic cleanup and never the release of another agent's intent.
  const staleCoordination = summarizeStaleCoordination({
    agents,
    claims,
    intents: allIntents,
    currentAgentId: currentAgent?.agent_id ?? null,
    maxItems,
  });
  if (staleCoordination.has_stale_state) {
    const parts: string[] = [];
    if (staleCoordination.stale_agents_count > 0) {
      parts.push(`${staleCoordination.stale_agents_count} stale agent(s)`);
    }
    if (staleCoordination.stale_active_claims_count > 0) {
      parts.push(`${staleCoordination.stale_active_claims_count} stale claim(s)`);
    }
    const oddOwned =
      staleCoordination.active_intents_owned_by_stale_agents_count +
      staleCoordination.active_intents_owned_by_terminated_agents_count +
      staleCoordination.active_intents_owned_by_missing_agents_count;
    if (oddOwned > 0) {
      parts.push(`${oddOwned} active intent(s) owned by stale/terminated/missing agents`);
    }
    if (staleCoordination.active_intents_with_no_active_claims_count > 0) {
      parts.push(`${staleCoordination.active_intents_with_no_active_claims_count} active intent(s) with no active claims`);
    }
    warnings.push(
      notice(
        'STALE_COORDINATION_STATE',
        'warning',
        `Stale coordination state present: ${parts.join(', ')}.`
          + ` Housekeeping is explicit: inspect with 'vibecode claims list', dry-run 'vibecode claims reap',`
          + ` and heartbeat your own agent. Do not release another agent's intent (release is same-agent only).`,
      ),
    );
  }

  const conflictRecords = listConflicts(repoRoot, undefined, { now: checkedAt }).filter(
    (c): c is ConflictRecord => Boolean(c) && typeof c === 'object',
  );
  const unresolved = conflictRecords.filter((c) => c.status === 'detected');

  // Phase 2D: enrich conflicts with triage context. Triage needs released
  // claims too (the bounded claim sections above exclude them) so a conflict
  // whose blocking claim was released triages as `cleared`, matching
  // vibecode_conflict_detail.
  const claimsForTriage = listFileClaims(repoRoot, { now: checkedAt, includeReleased: true });
  const triageResult = listConflictTriages({
    agents,
    claims: claimsForTriage,
    intents: allIntents,
    conflicts: unresolved,
    currentAgentId: currentAgent?.agent_id ?? null,
    now: checkedAt,
  });
  const triageByConflictId = new Map(triageResult.conflicts.map((t) => [t.conflict_id, t]));

  const stillBlockingCount = triageResult.conflicts.filter((t) => t.triage_status === 'still_blocking').length;
  const staleBlockingCount = triageResult.conflicts.filter((t) => t.triage_status === 'stale_blocking').length;
  const clearedCount = triageResult.conflicts.filter((t) => t.triage_status === 'cleared').length;

  const conflictsSection: SessionBootstrapResult['conflicts'] = {
    unresolved_count: unresolved.length,
    still_blocking_count: stillBlockingCount,
    stale_blocking_count: staleBlockingCount,
    cleared_count: clearedCount,
    items: unresolved.slice(0, maxItems).map((c) => {
      const triage = triageByConflictId.get(c.conflict_id);
      return {
        conflict_id: c.conflict_id,
        conflict_type: c.conflict_type,
        severity: c.severity,
        status: c.status,
        involved_files: Array.isArray(c.involved_files) ? c.involved_files : [],
        detected_at: c.detected_at,
        triage_status: triage?.triage_status ?? 'unresolved',
        blocking_agent_id: triage?.blocking_agent_id ?? null,
        blocking_agent_status: triage?.blocking_agent_status ?? 'missing',
        warning_codes: triage?.warning_codes ?? [],
      };
    }),
  };

  // Phase 2D: recommend conflict_resolution profile when still-blocking conflicts exist.
  if (stillBlockingCount > 0) {
    warnings.push(
      notice(
        'CONFLICTS_STILL_BLOCKING',
        'warning',
        `${stillBlockingCount} conflict(s) are still actively blocking. Use 'vibecode conflicts list' or 'vibecode conflicts detail --conflict-id <id>' to inspect them.`,
      ),
    );
  }

  // --- stale active claim detection (other-agent claims on clean files) ---
  let hasStaleCleanClaims = false;
  if (otherActiveClaims.length > 0 && changes.ok) {
    const dirtyPaths = new Set(changes.files.map((f) => f.path));
    const nowMs = Date.parse(checkedAt);
    const staleCleanClaims: typeof otherActiveClaims = [];
    for (const claim of otherActiveClaims) {
      if (dirtyPaths.has(claim.path)) continue;
      // Min-age grace: a fresh claim on a clean file is normal (work not
      // started yet). Unparseable created_at fails toward warning.
      const createdMs = Date.parse(claim.created_at);
      const ageMs = Number.isNaN(createdMs) ? Number.POSITIVE_INFINITY : nowMs - createdMs;
      if (ageMs < POSSIBLY_STALE_ACTIVE_CLAIM_MIN_AGE_MS) continue;
      staleCleanClaims.push(claim);
    }
    if (staleCleanClaims.length > 0) {
      hasStaleCleanClaims = true;
      const bounded = staleCleanClaims.slice(0, maxItems);
      const samplePaths = bounded.map((c) => c.path);
      const claimIds = bounded.map((c) => c.claim_id);
      const agentIds = [...new Set(bounded.map((c) => c.agent_id))];
      warnings.push(
        notice(
          'POSSIBLY_STALE_ACTIVE_CLAIMS',
          'warning',
          `${staleCleanClaims.length} active claim(s) from other agent(s) cover files that are not dirty — possibly stale/forgotten after previous work.`
            + ` Claims: ${claimIds.join(', ')}.`
            + ` Agents: ${agentIds.join(', ')}.`
            + ` Sample paths: ${samplePaths.join(', ')}.`
            + ` Use 'vibecode claims list' or 'vibecode claims reap' to inspect/release.`,
        ),
      );
    }
  }

  // --- codegraph status ---
  const codegraphProvider = input.codegraphStatus ?? defaultCodeGraphStatus;
  let codegraph: BootstrapCodeGraphStatus;
  try {
    codegraph = await codegraphProvider(repoRoot);
  } catch {
    codegraph = { available: false, initialized: false, version: null };
  }

  // --- project instructions (bounded excerpt from the strict allowlist) ---
  let projectInstructions: SessionBootstrapResult['project_instructions'] = {
    available: false,
    sources: [],
    excerpt: null,
    excerpt_truncated: false,
  };
  if (includeInstructions) {
    const instr = buildProjectInstructions(repoRoot);
    if (instr.source !== 'none' && instr.instructions.length > 0) {
      const first = instr.instructions[0];
      const buf = Buffer.from(first.excerpt, 'utf8');
      const truncated = buf.length > BOOTSTRAP_INSTRUCTION_EXCERPT_BYTES || first.truncated;
      const excerpt = buf.length > BOOTSTRAP_INSTRUCTION_EXCERPT_BYTES
        ? buf.subarray(0, BOOTSTRAP_INSTRUCTION_EXCERPT_BYTES).toString('utf8')
        : first.excerpt;
      projectInstructions = {
        available: true,
        sources: instr.instructions.map((i) => i.path),
        excerpt,
        excerpt_truncated: truncated,
      };
    }
  }

  const operatingMode = currentAgent ? getAgentOperatingMode(currentAgent) : null;
  // Phase 2B: an intent is releasable only when the tree is clean for this
  // agent — zero dirty claimed files (release would block on them) and zero
  // unclaimed dirty files (work in flight that should be claimed/committed
  // first). Summary counts cover ALL changed files, not the capped sample.
  const hasReleasableIntents =
    activeWorkIntents.length > 0 &&
    changes.ok &&
    changes.summary.claimed_by_agent === 0 &&
    changes.summary.unclaimed === 0;
  const rec = recommendations({
    registered: Boolean(currentAgent),
    hasAgentId: Boolean(input.agent_id),
    operatingMode,
    hasStaleCleanClaims,
    hasReleasableIntents,
    hasStillBlockingConflicts: stillBlockingCount > 0,
  });

  // --- runtime/preflight awareness (Phase 3B; pure over the data above) ---
  // For terminated/legacy sessions the identity resolution dropped the agent;
  // look the requested id up in the already-loaded agent list so the awareness
  // can report the real lifecycle status instead of "missing".
  const awarenessAgent =
    currentAgent ?? (input.agent_id ? agents.find((a) => a.agent_id === input.agent_id) ?? null : null);
  const ownActiveIntentsCount = currentAgent
    ? allIntents.filter((i) => i.status === 'active' && i.agent_id === currentAgent.agent_id).length
    : 0;
  const runtimeAwareness = getAgentRuntimeAwareness({
    agent: awarenessAgent,
    requestedAgentId: input.agent_id ?? null,
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
    activeIntentsCount: ownActiveIntentsCount,
    releasableIntentsCount: hasReleasableIntents ? ownActiveIntentsCount : 0,
    // Phase 3C: own ACTIVE claims (dirty or clean) for resume classification.
    activeClaimsCount: ownClaims.length,
    conflictTriages: triageResult.conflicts,
    staleCoordinationPresent: staleCoordination.has_stale_state,
    now: checkedAt,
  });

  // Phase 1B-3: context-aware tool-profile recommendations (ids + reasons only).
  const recommendedToolProfiles = recommendBootstrapToolProfiles({
    registered: Boolean(currentAgent),
    operatingMode,
    hasClaimedDirtyFiles: changes.ok && changes.summary.claimed_by_agent > 0,
    scanAvailable: scanCurrentRunAvailable,
    artifactsAvailable: currentRun.available && currentRun.available_artifacts.length > 0,
    hasConflictsOrStaleClaims:
      unresolved.length > 0 || hasStaleCleanClaims || staleClaims.length > 0,
    hasStaleCoordination: staleCoordination.has_stale_state,
  });

  // Phase 2C: append the explicit housekeeping commands/tools (deduped) when
  // stale coordination state exists.
  const recommendedTools = [...rec.tools];
  const recommendedCommands = [...rec.commands];
  if (staleCoordination.has_stale_state) {
    for (const tool of ['vibecode_claims_list', 'vibecode_claims_reap', ...(currentAgent ? ['vibecode_agent_heartbeat'] : [])]) {
      if (!recommendedTools.includes(tool)) recommendedTools.push(tool);
    }
    for (const command of staleCoordination.recommended_cli_commands) {
      if (!recommendedCommands.includes(command)) recommendedCommands.push(command);
    }
  }

  return {
    ok: blockers.length === 0,
    repo_root: repoRoot,
    generated_state_written: identity.stateWritten,
    git: gitSection,
    current_run: currentRun,
    agents: agentsSection,
    current_agent: currentAgent ? toIdentity(currentAgent) : null,
    claims: claimsSection,
    active_work_intents: activeWorkIntents,
    conflicts: conflictsSection,
    stale_coordination: staleCoordination,
    evidence: {
      recent_count: coordination.evidence.recent_count,
      warning_count: coordination.evidence.warning_count,
      high_count: coordination.evidence.high_count,
      last_event_at: coordination.evidence.last_event_at,
    },
    scan: { current_run_scan_available: scanCurrentRunAvailable },
    codegraph: { available: codegraph.available, initialized: codegraph.initialized, stale: false },
    project_instructions: projectInstructions,
    runtime_awareness: runtimeAwareness,
    agent_protocol: [...AGENT_OPERATING_PROTOCOL],
    warnings,
    blockers,
    recommended_next_tools: recommendedTools,
    recommended_cli_commands: recommendedCommands,
    recommended_tool_profiles: recommendedToolProfiles,
    checked_at: checkedAt,
  };
}
