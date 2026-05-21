import fs from 'fs';
import path from 'path';

export interface TerminalContextIncluded {
  included: true;
  reason: string;
  sourceRunId?: string;
  sourcePath?: string;
  excerpt: string;
}

export interface TerminalContextNotIncluded {
  included: false;
  reason: string;
}

export type TerminalContextInput = TerminalContextIncluded | TerminalContextNotIncluded;

export interface TerminalContextArtifact {
  included: boolean;
  reason: string;
  source_run_id?: string;
  source_path?: string;
  excerpt?: string;
  excerpt_char_count?: number;
  line_count?: number;
  warnings: string[];
}

/**
 * Write terminal_context.json to the run directory.
 * This is a generated/runtime artifact for the prompt pipeline.
 * It must NOT be placed inside scan/ (scanner must not pick it up).
 */
export function writeTerminalContextArtifact(
  runDir: string,
  input: TerminalContextInput,
): string {
  const artifactPath = path.join(runDir, 'terminal_context.json');

  let artifact: TerminalContextArtifact;

  if (input.included) {
    const lines = input.excerpt.split('\n');
    artifact = {
      included: true,
      reason: input.reason,
      source_run_id: input.sourceRunId,
      source_path: input.sourcePath,
      excerpt: input.excerpt,
      excerpt_char_count: input.excerpt.length,
      line_count: lines.length,
      warnings: [],
    };
  } else {
    artifact = {
      included: false,
      reason: input.reason,
      warnings: [],
    };
  }

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
  return artifactPath;
}
