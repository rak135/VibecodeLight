import fs from 'fs';
import path from 'path';

import { getCoordinationPaths } from './state.js';
import type { ChangedPathClassification } from './path_classification.js';

/**
 * Phase 4C watcher evidence — event model + storage.
 *
 * Evidence is GENERATED state only: append-only JSONL at
 * `.vibecode/coordination/events.jsonl`. It is never committed, never stores
 * file contents/diffs/secrets, and is non-enforcing. It records that a path
 * CHANGED relative to the active advisory claims — it never asserts which agent
 * physically edited a file.
 */

/** Severity of an evidence event (advisory only; never blocks). */
export type EvidenceSeverity = 'info' | 'warning' | 'high';

/** Where the observation came from. */
export type EvidenceSource = 'fs_watch' | 'manual_scan' | 'test';

/** A single appended evidence record. */
export interface CoordinationEvidenceEvent {
  event_id: string;
  event_type: 'file_changed';
  detected_at: string;
  path: string;
  original_path?: string;
  git_status?: string;
  classification: ChangedPathClassification;
  claim_id?: string;
  owning_agent_id?: string;
  owning_agent_name?: string;
  run_id?: string | null;
  severity: EvidenceSeverity;
  message: string;
  detector: 'watcher';
  evidence: {
    source: EvidenceSource;
    raw_event?: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Maximum number of evidence events retained in the log. Append applies a
 * best-effort retention cap by rewriting the file with the newest events when
 * the cap is exceeded. This bounds the generated file without a separate
 * compaction step.
 */
export const MAX_EVIDENCE_EVENTS = 1000;

/** Resolve the absolute path to the generated evidence log. */
export function getEvidenceLogPath(repoRoot: string): string {
  return path.join(getCoordinationPaths(repoRoot).dir, 'events.jsonl');
}

/**
 * Read the evidence log resiliently. A missing file yields `[]` and never
 * creates the file; malformed JSONL lines are skipped rather than throwing.
 */
export function readEvidenceEvents(
  repoRoot: string,
  options: { limit?: number } = {},
): CoordinationEvidenceEvent[] {
  const logPath = getEvidenceLogPath(repoRoot);
  if (!fs.existsSync(logPath)) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }

  const events: CoordinationEvidenceEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CoordinationEvidenceEvent;
      if (parsed && typeof parsed === 'object' && parsed.event_type === 'file_changed') {
        events.push(parsed);
      }
    } catch {
      // Skip a corrupt/partial line; evidence reads must never crash.
    }
  }

  if (typeof options.limit === 'number' && options.limit >= 0 && events.length > options.limit) {
    return events.slice(events.length - options.limit);
  }
  return events;
}

function writeAllEvents(logPath: string, events: readonly CoordinationEvidenceEvent[]): void {
  const body = events.map((event) => JSON.stringify(event)).join('\n');
  fs.writeFileSync(logPath, events.length > 0 ? `${body}\n` : '', 'utf8');
}

/**
 * Append one or more evidence events to the generated JSONL log, applying the
 * retention cap. Writes ONLY `.vibecode/coordination/events.jsonl`; touches no
 * source files and no other state.
 */
export function appendEvidenceEvents(
  repoRoot: string,
  newEvents: readonly CoordinationEvidenceEvent[],
): void {
  if (newEvents.length === 0) return;
  const logPath = getEvidenceLogPath(repoRoot);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  // Fast path: plain append when the log stays under the cap. Otherwise rewrite
  // the file keeping only the newest MAX_EVIDENCE_EVENTS records.
  const existing = readEvidenceEvents(repoRoot);
  const combined = existing.concat(newEvents);
  if (combined.length <= MAX_EVIDENCE_EVENTS) {
    const lines = newEvents.map((event) => JSON.stringify(event)).join('\n');
    fs.appendFileSync(logPath, `${lines}\n`, 'utf8');
    return;
  }
  writeAllEvents(logPath, combined.slice(combined.length - MAX_EVIDENCE_EVENTS));
}
