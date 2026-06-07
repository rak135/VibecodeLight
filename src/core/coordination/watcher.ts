import { randomUUID } from 'crypto';

import { listAgents } from './agents.js';
import { readAgentBinding } from './agent_binding.js';
import { listFileClaims } from './claims.js';
import {
  classifyChangedPath,
  type ChangedPathClassification,
  type ChangedPathClassificationResult,
} from './path_classification.js';
import {
  appendEvidenceEvents,
  readEvidenceEvents,
  type CoordinationEvidenceEvent,
  type EvidenceSeverity,
  type EvidenceSource,
} from './watcher_events.js';
import { resolveExplicitRunDir } from '../runs/run_resolver.js';
import {
  getGitChangedFiles,
  type GitChangedFile,
} from '../workspace/git_changed_files.js';
import type { FileClaim } from './types.js';

/**
 * Phase 4C watcher evidence service (non-enforcing).
 *
 * This layer provides EARLY VISIBILITY into suspicious edits. It is NOT an
 * enforcement gate: it never blocks writes, never mutates source files, never
 * stages/commits, and never auto-resolves conflicts. Enforcement remains with
 * advisory claims, the finalize check, and the scoped commit guard.
 *
 * The Phase 4C deliverable is the evidence FOUNDATION + a manual scan helper.
 * A live filesystem-watch service is intentionally deferred to a later phase to
 * avoid fragile real-time watcher tests on Windows; the classification + append
 * + read surfaces here are what a thin live watcher would call.
 */

const SEVERITY_BY_CLASSIFICATION: Record<ChangedPathClassification, EvidenceSeverity> = {
  claimed_by_agent: 'info',
  generated_or_ignored: 'info',
  unclaimed: 'warning',
  unknown: 'warning',
  claimed_by_other_active_agent: 'high',
};

/** A small window of recent events summarized into coordination status. */
export const RECENT_EVIDENCE_WINDOW = 50;

export interface EvidenceSummary {
  recent_count: number;
  warning_count: number;
  high_count: number;
  last_event_at: string | null;
}

export interface RecordFileChangeEvidenceInput {
  repoRoot: string;
  path: string;
  raw_event?: string;
  agent_id?: string;
  run_id?: string;
  now?: Date | string;
  source?: EvidenceSource;
  git_status?: string;
  original_path?: string;
  /** Test seam: inject a deterministic event id. */
  eventId?: string;
}

export interface ScanChangedFilesInput {
  repoRoot: string;
  agent_id?: string;
  run_id?: string;
  now?: Date | string;
  source?: EvidenceSource;
}

export interface ScanChangedFilesResult {
  ok: boolean;
  events: CoordinationEvidenceEvent[];
  warnings: string[];
}

function toIso(now: Date | string | undefined): string {
  if (typeof now === 'string') return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

interface AgentContext {
  agentId: string | null;
  runId: string | null;
}

/**
 * Best-effort agent/run context for an evidence observation. This never throws:
 * evidence is non-enforcing, so an unresolvable run id simply yields a null
 * agent/run rather than failing the observation.
 */
function resolveAgentContext(repoRoot: string, agentId?: string, runId?: string): AgentContext {
  let resolvedRunId: string | null = runId ?? null;
  let boundAgentId: string | null = null;
  if (runId) {
    try {
      const resolved = resolveExplicitRunDir(repoRoot, runId);
      resolvedRunId = resolved.runId;
      const binding = readAgentBinding(resolved.runDir);
      boundAgentId = binding?.agent_id ?? null;
    } catch {
      // Unresolvable run id: keep the raw value, leave agent unresolved.
      resolvedRunId = runId;
    }
  }
  return { agentId: agentId ?? boundAgentId, runId: resolvedRunId };
}

interface ClaimSnapshot {
  activeClaims: FileClaim[];
  staleClaims: FileClaim[];
  agentNames: Map<string, string>;
}

function loadClaimSnapshot(repoRoot: string, now: string): ClaimSnapshot {
  const readOptions = { now };
  const allClaims = listFileClaims(repoRoot, readOptions); // released excluded
  const agents = listAgents(repoRoot, readOptions);
  return {
    activeClaims: allClaims.filter((claim) => claim.status === 'active'),
    staleClaims: allClaims.filter((claim) => claim.status !== 'active'),
    agentNames: new Map(agents.map((agent) => [agent.agent_id, agent.agent_name])),
  };
}

function messageFor(
  changedPath: string,
  result: ChangedPathClassificationResult,
): string {
  switch (result.classification) {
    case 'claimed_by_agent':
      return `File ${changedPath} changed while ${result.owning_agent_name ?? 'this agent'} held an active claim.`;
    case 'claimed_by_other_active_agent':
      return `File ${changedPath} changed while claimed by another active agent (${result.owning_agent_name ?? result.owning_agent_id ?? 'unknown'}).`;
    case 'generated_or_ignored':
      return `File ${changedPath} is a generated/ignored runtime path.`;
    case 'unknown':
      return `File ${changedPath} changed; claim ownership could not be determined.`;
    case 'unclaimed':
    default:
      return `File ${changedPath} changed without an active matching claim.`;
  }
}

interface BuildEventInput {
  changedPath: string;
  detectedAt: string;
  source: EvidenceSource;
  runId: string | null;
  eventId?: string;
  rawEvent?: string;
  gitStatus?: string;
  originalPath?: string;
}

function buildEvent(
  input: BuildEventInput,
  result: ChangedPathClassificationResult,
): CoordinationEvidenceEvent {
  const event: CoordinationEvidenceEvent = {
    event_id: input.eventId ?? `evt-${randomUUID()}`,
    event_type: 'file_changed',
    detected_at: input.detectedAt,
    path: input.changedPath,
    classification: result.classification,
    run_id: input.runId,
    severity: SEVERITY_BY_CLASSIFICATION[result.classification],
    message: messageFor(input.changedPath, result),
    detector: 'watcher',
    evidence: { source: input.source },
  };
  if (input.originalPath) event.original_path = input.originalPath;
  if (input.gitStatus) event.git_status = input.gitStatus;
  if (result.owning_claim_id) event.claim_id = result.owning_claim_id;
  if (result.owning_agent_id) event.owning_agent_id = result.owning_agent_id;
  if (result.owning_agent_name) event.owning_agent_name = result.owning_agent_name;
  if (input.rawEvent) event.evidence.raw_event = input.rawEvent;
  if (result.stale_overlap_claim_id) {
    event.evidence.details = {
      stale_overlap_claim_id: result.stale_overlap_claim_id,
      stale_overlap_agent_id: result.stale_overlap_agent_id,
    };
  }
  return event;
}

/**
 * Classify a single changed path against the live advisory claims and append a
 * generated evidence event. Read-only against git/source; writes only the
 * generated evidence log. Returns the recorded event.
 */
export function recordFileChangeEvidence(
  input: RecordFileChangeEvidenceInput,
): CoordinationEvidenceEvent {
  const detectedAt = toIso(input.now);
  const ctx = resolveAgentContext(input.repoRoot, input.agent_id, input.run_id);
  const snapshot = loadClaimSnapshot(input.repoRoot, detectedAt);
  const result = classifyChangedPath({
    path: input.path,
    agentId: ctx.agentId,
    activeClaims: snapshot.activeClaims,
    staleClaims: snapshot.staleClaims,
    agentNames: snapshot.agentNames,
  });
  const event = buildEvent(
    {
      changedPath: input.path,
      detectedAt,
      source: input.source ?? 'manual_scan',
      runId: ctx.runId,
      eventId: input.eventId,
      rawEvent: input.raw_event,
      gitStatus: input.git_status,
      originalPath: input.original_path,
    },
    result,
  );
  appendEvidenceEvents(input.repoRoot, [event]);
  return event;
}

/**
 * Manual scan: read the read-only git changed files and append one evidence
 * event per changed path, classified against the live advisory claims. This is
 * the Phase 4C visibility entry point. It never mutates git or source files; it
 * writes only the generated evidence log.
 */
export function scanChangedFilesToEvidence(
  input: ScanChangedFilesInput,
): ScanChangedFilesResult {
  const detectedAt = toIso(input.now);
  const changed = getGitChangedFiles(input.repoRoot);
  if (!changed.ok) {
    return { ok: false, events: [], warnings: changed.warnings };
  }

  const ctx = resolveAgentContext(input.repoRoot, input.agent_id, input.run_id);
  const snapshot = loadClaimSnapshot(input.repoRoot, detectedAt);
  const source = input.source ?? 'manual_scan';

  const events = changed.files.map((file: GitChangedFile) => {
    const result = classifyChangedPath({
      path: file.path,
      agentId: ctx.agentId,
      activeClaims: snapshot.activeClaims,
      staleClaims: snapshot.staleClaims,
      agentNames: snapshot.agentNames,
    });
    return buildEvent(
      {
        changedPath: file.path,
        detectedAt,
        source,
        runId: ctx.runId,
        gitStatus: `${file.index_status}${file.worktree_status}`,
        originalPath: file.original_path,
      },
      result,
    );
  });

  appendEvidenceEvents(input.repoRoot, events);
  return { ok: true, events, warnings: [] };
}

/** Read the generated evidence log (resilient, read-only). Newest events last. */
export function listCoordinationEvidence(
  input: { repoRoot: string; limit?: number },
): CoordinationEvidenceEvent[] {
  return readEvidenceEvents(input.repoRoot, { limit: input.limit });
}

/** Summarize a list of evidence events for compact status reporting. */
export function summarizeEvidence(events: readonly CoordinationEvidenceEvent[]): EvidenceSummary {
  let warning_count = 0;
  let high_count = 0;
  for (const event of events) {
    if (event.severity === 'warning') warning_count += 1;
    else if (event.severity === 'high') high_count += 1;
  }
  const last = events.length > 0 ? events[events.length - 1] : null;
  return {
    recent_count: events.length,
    warning_count,
    high_count,
    last_event_at: last ? last.detected_at : null,
  };
}

/** Read and summarize the most recent evidence window for coordination status. */
export function summarizeRecentEvidence(repoRoot: string): EvidenceSummary {
  return summarizeEvidence(readEvidenceEvents(repoRoot, { limit: RECENT_EVIDENCE_WINDOW }));
}
