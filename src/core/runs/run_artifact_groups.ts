import fs from 'fs';
import path from 'path';

import { RUN_SHOW_ARTIFACTS } from './run_artifacts.js';

/**
 * Stable artifact descriptor list used by the MCP-3 `vibecode_artifacts_list`
 * tool. Every descriptor maps an agent-facing name (the same alias the
 * `vibecode_artifact_read` tool accepts) to a canonical run-relative path,
 * a group, a recommendation flag, and a short description.
 *
 * Hard rules:
 *   - every `path` MUST be a member of `RUN_SHOW_ARTIFACTS` so the
 *     `vibecode_artifacts_list` and `vibecode_artifact_read` allowlists stay
 *     in lock-step;
 *   - paths use forward slashes only, never absolute, never `..` traversal;
 *   - no descriptor adds a tool that returns content — this list is purely
 *     metadata.
 */

export type RunArtifactGroup =
  | 'prompt'
  | 'context'
  | 'flash'
  | 'codegraph'
  | 'terminal'
  | 'checks'
  | 'run';

export interface RunArtifactDescriptor {
  /** Agent-facing alias (same string the `artifact_read` tool accepts). */
  name: string;
  /** Run-relative path inside `<runDir>/`. */
  path: string;
  group: RunArtifactGroup;
  /** True if the agent should usually open this artifact during orientation. */
  recommended_for_agent: boolean;
  description: string;
}

export const RUN_ARTIFACT_DESCRIPTORS: readonly RunArtifactDescriptor[] = Object.freeze([
  {
    name: 'final_prompt',
    path: 'output/final_prompt.md',
    group: 'prompt',
    recommended_for_agent: true,
    description: 'The final prompt sent to the terminal — the canonical "truth" of the run.',
  },
  {
    name: 'context_pack',
    path: 'output/context_pack.md',
    group: 'context',
    recommended_for_agent: true,
    description: 'Compact context pack consumed by the main agent run.',
  },
  {
    name: 'user_prompt',
    path: 'user_prompt.md',
    group: 'prompt',
    recommended_for_agent: false,
    description: 'Original user prompt before normalization and context build.',
  },
  {
    name: 'task_intent',
    path: 'task_intent.json',
    group: 'context',
    recommended_for_agent: false,
    description: 'Structured task intent produced by the normalizer.',
  },
  {
    name: 'task_intent_md',
    path: 'task_intent.md',
    group: 'context',
    recommended_for_agent: false,
    description: 'Human-readable task intent summary.',
  },
  {
    name: 'run_manifest',
    path: 'run_manifest.json',
    group: 'run',
    recommended_for_agent: false,
    description: 'Run identity, repo binding, status and ordering metadata.',
  },
  {
    name: 'scanner_config',
    path: 'scanner_config.json',
    group: 'run',
    recommended_for_agent: false,
    description: 'Resolved scanner configuration handed to the Python scanner.',
  },
  {
    name: 'flash_input',
    path: 'flash/flash_input.md',
    group: 'flash',
    recommended_for_agent: false,
    description: 'Markdown input given to the flash model.',
  },
  {
    name: 'flash_output',
    path: 'flash/flash_output.md',
    group: 'flash',
    recommended_for_agent: false,
    description: 'Markdown output from the flash model.',
  },
  {
    name: 'selected_skills',
    path: 'skills/selected_skills.json',
    group: 'context',
    recommended_for_agent: false,
    description: 'Skills selected for this run.',
  },
  {
    name: 'send_metadata',
    path: 'terminal/send_metadata.json',
    group: 'terminal',
    recommended_for_agent: false,
    description: 'Send metadata captured when the prompt was sent to the terminal.',
  },
  {
    name: 'codegraph_usage',
    path: 'scan/codegraph_usage.json',
    group: 'codegraph',
    recommended_for_agent: true,
    description: 'CodeGraph mode/transport/fallback summary for this run.',
  },
  {
    name: 'codegraph_context',
    path: 'scan/codegraph_context.md',
    group: 'codegraph',
    recommended_for_agent: false,
    description: 'Bounded CodeGraph context used during the run, if any.',
  },
  {
    name: 'codegraph_repo_atlas',
    path: 'scan/codegraph_repo_atlas.md',
    group: 'codegraph',
    recommended_for_agent: false,
    description: 'CodeGraph-derived repo atlas (markdown).',
  },
  {
    name: 'repo_atlas',
    path: 'scan/repo_atlas.md',
    group: 'codegraph',
    recommended_for_agent: false,
    description: 'Read-only repo atlas (markdown).',
  },
]);

/** Verify at module load that every descriptor path is in the shared allowlist. */
for (const desc of RUN_ARTIFACT_DESCRIPTORS) {
  if (!RUN_SHOW_ARTIFACTS.has(desc.path)) {
    throw new Error(
      `RUN_ARTIFACT_DESCRIPTORS misalignment: ${desc.path} is not a member of RUN_SHOW_ARTIFACTS`,
    );
  }
}

export interface ArtifactPresenceEntry extends RunArtifactDescriptor {
  exists: boolean;
  size_bytes: number | null;
}

export interface ArtifactsListSummary {
  artifacts: ArtifactPresenceEntry[];
  /** Names of artifacts the agent should usually read first. */
  recommended_next_reads: string[];
  /** Group → names mapping for at-a-glance navigation. */
  groups: Record<RunArtifactGroup, string[]>;
}

/**
 * Walk the descriptor list against an actual run directory and return the
 * presence + size of every allowlisted artifact. Never reads file content.
 */
export function listRunArtifacts(runDir: string): ArtifactsListSummary {
  const entries: ArtifactPresenceEntry[] = [];
  const groups: Record<RunArtifactGroup, string[]> = {
    prompt: [],
    context: [],
    flash: [],
    codegraph: [],
    terminal: [],
    checks: [],
    run: [],
  };
  for (const desc of RUN_ARTIFACT_DESCRIPTORS) {
    const abs = path.join(runDir, ...desc.path.split('/'));
    let exists = false;
    let size: number | null = null;
    try {
      const stat = fs.statSync(abs);
      exists = stat.isFile();
      if (exists) size = stat.size;
    } catch {
      exists = false;
    }
    entries.push({ ...desc, exists, size_bytes: size });
    groups[desc.group].push(desc.name);
  }
  return {
    artifacts: entries,
    recommended_next_reads: RUN_ARTIFACT_DESCRIPTORS.filter((d) => d.recommended_for_agent).map((d) => d.name),
    groups,
  };
}
