import fs from 'fs';
import path from 'path';

import { getWorkspacePaths } from '../workspace/paths.js';
import {
  COORDINATION_STATE_VERSION,
  type AgentSession,
  type ClaimIntent,
  type FileClaim,
  type WorkspaceCoordinationState,
} from './types.js';

export { COORDINATION_STATE_VERSION } from './types.js';
export type { WorkspaceCoordinationState } from './types.js';

/**
 * Persistence for the Phase 1 coordination state.
 *
 * Hard rules enforced here:
 *   - All generated state lives under `.vibecode/coordination/` only.
 *   - Loading is **read-only** — a missing file yields a stable empty state and
 *     never writes to disk. Only `initializeCoordinationState` writes, and only
 *     the single `state.json` file under `.vibecode/coordination/`.
 *   - No source files are touched; no lock files are ever created (claims are
 *     advisory only).
 */

/** Resolved on-disk locations for coordination state. */
export interface CoordinationPaths {
  /** `.vibecode/coordination/` directory. */
  dir: string;
  /** `.vibecode/coordination/state.json` file. */
  stateFile: string;
}

/** Resolve the coordination state paths for a repo root. */
export function getCoordinationPaths(repoRoot: string): CoordinationPaths {
  const dir = path.join(getWorkspacePaths(repoRoot).vibecode, 'coordination');
  return { dir, stateFile: path.join(dir, 'state.json') };
}

/** Build the minimal default empty coordination state. */
export function createEmptyCoordinationState(
  workspaceRoot: string,
  now: string = new Date().toISOString(),
): WorkspaceCoordinationState {
  return {
    version: COORDINATION_STATE_VERSION,
    workspace_root: workspaceRoot,
    last_updated: now,
    agents: [],
    claims: [],
    conflicts: [],
    handoffs: [],
    intents: [],
  };
}

/** Normalize a parsed JSON value into a complete coordination state. */
function normalize(
  value: unknown,
  workspaceRoot: string,
  fallbackNow: string,
): WorkspaceCoordinationState {
  const raw = (value ?? {}) as Partial<WorkspaceCoordinationState>;
  const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
  return {
    version: typeof raw.version === 'number' ? raw.version : COORDINATION_STATE_VERSION,
    workspace_root: typeof raw.workspace_root === 'string' ? raw.workspace_root : workspaceRoot,
    last_updated: typeof raw.last_updated === 'string' ? raw.last_updated : fallbackNow,
    // Generated state is trusted: agents are preserved verbatim (no element
    // schema is enforced here) so existing sessions survive a round-trip.
    agents: asArray(raw.agents) as readonly AgentSession[],
    claims: asArray(raw.claims) as readonly FileClaim[],
    conflicts: asArray(raw.conflicts),
    handoffs: asArray(raw.handoffs),
    // Additive Phase 2A field: older state files have no `intents` key and
    // normalize to an empty list, preserving backward compatibility.
    intents: asArray(raw.intents) as readonly ClaimIntent[],
  };
}

/**
 * Read the coordination state for a repo. Read-only: if the state file does not
 * exist (or cannot be parsed), a stable empty state is returned and nothing is
 * written to disk.
 */
export function loadCoordinationState(
  repoRoot: string,
  options: { now?: string } = {},
): WorkspaceCoordinationState {
  const now = options.now ?? new Date().toISOString();
  const { stateFile } = getCoordinationPaths(repoRoot);
  if (!fs.existsSync(stateFile)) {
    return createEmptyCoordinationState(repoRoot, now);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return normalize(parsed, repoRoot, now);
  } catch {
    // Corrupt/unreadable generated state degrades to a stable empty state
    // rather than throwing; status reporting must never crash on bad state.
    return createEmptyCoordinationState(repoRoot, now);
  }
}

/** Result of an initialize attempt. */
export interface InitializeCoordinationResult {
  /** Absolute path to the state file. */
  stateFile: string;
  /** True when this call created the file; false when it already existed. */
  created: boolean;
  /** The on-disk (or freshly written) state. */
  state: WorkspaceCoordinationState;
}

/**
 * Safely initialize generated coordination state. Idempotent: if the state file
 * already exists it is loaded and returned unchanged. When it is missing, the
 * `.vibecode/coordination/` directory and a single `state.json` are created.
 * No source files are modified; no lock files are created.
 */
export function initializeCoordinationState(
  repoRoot: string,
  options: { now?: string } = {},
): InitializeCoordinationResult {
  const now = options.now ?? new Date().toISOString();
  const paths = getCoordinationPaths(repoRoot);
  if (fs.existsSync(paths.stateFile)) {
    return { stateFile: paths.stateFile, created: false, state: loadCoordinationState(repoRoot, { now }) };
  }
  const state = createEmptyCoordinationState(repoRoot, now);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { stateFile: paths.stateFile, created: true, state };
}

/**
 * Persist a full coordination state document. This is the ONLY mutation seam
 * used by the Phase 2 agent services: it writes the single `state.json` under
 * `.vibecode/coordination/` and nothing else. No source files, no lock files,
 * and never `.vibecode/coordination/config.json`. Callers are responsible for
 * bumping `last_updated` before writing.
 */
export function writeCoordinationState(
  repoRoot: string,
  state: WorkspaceCoordinationState,
): string {
  const paths = getCoordinationPaths(repoRoot);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return paths.stateFile;
}
