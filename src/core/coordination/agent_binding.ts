import fs from 'fs';
import path from 'path';

import { CoordinationError } from './errors.js';
import { getAgentStatus } from './agents.js';

/**
 * Phase 3B run/agent binding.
 *
 * A prompt run can be optionally associated with a coordinating agent. Because
 * {@link import('../models/index.js').RunManifest} is intentionally minimal, the
 * binding is stored as a SEPARATE generated artifact under the run, never merged
 * into run_manifest.json:
 *
 *   .vibecode/runs/<run_id>/coordination/agent_binding.json
 *
 * Hard rules:
 *   - This module only ever writes/reads that single file under the run dir.
 *   - It never touches source files and never creates lock files.
 *   - Reads are resilient: a missing or malformed file yields `null`.
 */

/** Tooling capability of the bound agent. Drives which instructions are shown. */
export const AGENT_MODES = ['mcp', 'cli', 'unknown'] as const;

/** A bound agent's tooling capability. */
export type AgentMode = (typeof AGENT_MODES)[number];

/** Type guard: is `value` one of the recognized {@link AgentMode}s? */
export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === 'string' && (AGENT_MODES as readonly string[]).includes(value);
}

/** The optional run/agent binding persisted alongside a run. */
export interface AgentBinding {
  /** Bound agent id, when an agent is associated with the run. */
  agent_id: string | null;
  /** Owning terminal session id, when known. */
  terminal_session_id: string | null;
  /** Tooling capability used to tailor coordination instructions. */
  agent_mode: AgentMode;
  /** Whether the coordination prompt block should be rendered for this run. */
  coordination_enabled: boolean;
}

/** Resolve the per-run coordination paths. */
export function getRunCoordinationPaths(runDir: string): { dir: string; bindingFile: string } {
  const dir = path.join(runDir, 'coordination');
  return { dir, bindingFile: path.join(dir, 'agent_binding.json') };
}

/**
 * Persist the run/agent binding. Validates `agent_mode` and writes the single
 * `coordination/agent_binding.json` under the run dir. Returns the file path.
 */
export function writeAgentBinding(runDir: string, binding: AgentBinding): string {
  if (!isAgentMode(binding.agent_mode)) {
    throw new CoordinationError('INVALID_AGENT_MODE', `invalid agent_mode: ${JSON.stringify(binding.agent_mode)}`, {
      agent_mode: binding.agent_mode,
    });
  }
  const normalized: AgentBinding = {
    agent_id: binding.agent_id ?? null,
    terminal_session_id: binding.terminal_session_id ?? null,
    agent_mode: binding.agent_mode,
    coordination_enabled: binding.coordination_enabled === true,
  };
  const { dir, bindingFile } = getRunCoordinationPaths(runDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bindingFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return bindingFile;
}

/**
 * Read the run/agent binding. Read-only and resilient: returns `null` when the
 * artifact is missing, unreadable, malformed, or carries an unrecognized mode.
 */
export function readAgentBinding(runDir: string): AgentBinding | null {
  const { bindingFile } = getRunCoordinationPaths(runDir);
  if (!fs.existsSync(bindingFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(bindingFile, 'utf8')) as Partial<AgentBinding>;
    if (!isAgentMode(raw.agent_mode)) return null;
    return {
      agent_id: typeof raw.agent_id === 'string' ? raw.agent_id : null,
      terminal_session_id: typeof raw.terminal_session_id === 'string' ? raw.terminal_session_id : null,
      agent_mode: raw.agent_mode,
      coordination_enabled: raw.coordination_enabled === true,
    };
  } catch {
    return null;
  }
}

/** Caller-supplied coordination flags (e.g. from the CLI `prompt` command). */
export interface AgentBindingInput {
  agentId?: string;
  terminalSessionId?: string;
  agentMode?: string;
}

/** Structured error returned by {@link resolveAgentBindingInput}. */
export interface AgentBindingInputError {
  code: string;
  message: string;
  details: string[];
}

/** Result of resolving caller flags into a binding (or a structured error). */
export type ResolveAgentBindingResult =
  | { ok: true; binding: AgentBinding | null }
  | { ok: false; error: AgentBindingInputError };

/**
 * Validate caller-supplied coordination flags against live coordination state
 * and produce an {@link AgentBinding}.
 *
 *   - No flags supplied → `{ ok: true, binding: null }` (no coordination block).
 *   - Invalid `agentMode` → structured `INVALID_AGENT_MODE` error.
 *   - Unknown `agentId` → structured `AGENT_NOT_FOUND` error.
 *
 * Validation is read-only; it never mutates coordination state.
 */
export function resolveAgentBindingInput(
  repoRoot: string,
  input: AgentBindingInput,
  options: { now?: string } = {},
): ResolveAgentBindingResult {
  const requested = Boolean(input.agentId || input.agentMode || input.terminalSessionId);
  if (!requested) return { ok: true, binding: null };

  let mode: AgentMode = 'unknown';
  if (input.agentMode !== undefined) {
    if (!isAgentMode(input.agentMode)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_AGENT_MODE',
          message: `invalid agent mode: ${JSON.stringify(input.agentMode)} (expected mcp | cli | unknown)`,
          details: [`agent_mode: ${String(input.agentMode)}`],
        },
      };
    }
    mode = input.agentMode;
  }

  if (input.agentId) {
    try {
      getAgentStatus(repoRoot, input.agentId, options.now ? { now: options.now } : {});
    } catch (error) {
      if (error instanceof CoordinationError) {
        return { ok: false, error: { code: error.code, message: error.message, details: [] } };
      }
      throw error;
    }
  }

  return {
    ok: true,
    binding: {
      agent_id: input.agentId ?? null,
      terminal_session_id: input.terminalSessionId ?? null,
      agent_mode: mode,
      coordination_enabled: true,
    },
  };
}
