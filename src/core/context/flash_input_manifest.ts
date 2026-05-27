import path from 'path';

import { readSavedArtifact } from './artifact_reader.js';

export const FLASH_INPUT_REQUIRED_INPUTS = {
  user_prompt: 'user_prompt.md',
  run_manifest: 'run_manifest.json',
  scanner_config: 'scanner_config.json',
  scan_manifest: 'scan/scan_manifest.json',
  skills_catalog: 'skills/skills_catalog.json',
} as const;

export const FLASH_INPUT_OPTIONAL_INPUTS = {
  repo_tree: 'scan/repo_tree.txt',
  file_inventory: 'scan/file_inventory.json',
  git_status: 'scan/git_status.json',
  git_diff_stat: 'scan/git_diff_stat.txt',
  ignore_rules: 'scan/ignore_rules.json',
  config_snapshot: 'scan/config_snapshot.json',
  manifests: 'scan/manifests.json',
  environment: 'scan/environment.json',
  commands: 'scan/commands.json',
  tooling: 'scan/tooling.json',
  repo_instructions: 'scan/repo_instructions.json',
  docs: 'scan/docs.json',
  architecture_docs: 'scan/architecture_docs.json',
  symbols: 'scan/symbols.json',
  imports: 'scan/imports.json',
  entrypoints: 'scan/entrypoints.json',
  tests: 'scan/tests.json',
  schemas: 'scan/schemas.json',
  keyword_hits: 'scan/keyword_hits.json',
  recent_history: 'scan/recent_history.json',
} as const;

const CODEGRAPH_CONTEXT_OPTIONAL_INPUT = {
  codegraph_context: 'scan/codegraph_context.md',
} as const;

const CODEGRAPH_REPO_ATLAS_OPTIONAL_INPUTS = {
  repo_atlas: 'scan/repo_atlas.md',
  repo_atlas_json: 'scan/repo_atlas.json',
} as const;

const CODEGRAPH_OPTIONAL_INPUTS = {
  ...CODEGRAPH_REPO_ATLAS_OPTIONAL_INPUTS,
  ...CODEGRAPH_CONTEXT_OPTIONAL_INPUT,
} as const;

export interface FlashInputManifest {
  run_id: string;
  created_at: string;
  task: string;
  repo_root: string;
  required_inputs: Record<string, string>;
  optional_inputs: Record<string, string>;
  missing_inputs: string[];
  warnings: string[];
  artifacts: Record<string, string>;
}

export interface BuildFlashInputManifestOptions {
  run_id: string;
  task: string;
  repo_root: string;
  runDir: string;
}

export class FlashInputManifestError extends Error {
  code: string;

  path?: string;

  details: string[];

  constructor(code: string, message: string, pathValue?: string, details: string[] = []) {
    super(message);
    this.name = 'FlashInputManifestError';
    this.code = code;
    this.path = pathValue;
    this.details = details;
  }
}

function optionalInputsForRun(runDir: string): Record<string, string> {
  const optionalInputs: Record<string, string> = { ...FLASH_INPUT_OPTIONAL_INPUTS };
  for (const [key, relativePath] of Object.entries(CODEGRAPH_OPTIONAL_INPUTS)) {
    if (readSavedArtifact(runDir, relativePath) !== null) {
      optionalInputs[key] = relativePath;
    }
  }
  return optionalInputs;
}

export function buildFlashInputManifest(opts: BuildFlashInputManifestOptions): FlashInputManifest {
  // Check required inputs exist
  const missingRequired: string[] = [];
  for (const relativePath of Object.values(FLASH_INPUT_REQUIRED_INPUTS)) {
    if (readSavedArtifact(opts.runDir, relativePath) === null) {
      missingRequired.push(relativePath);
    }
  }

  if (missingRequired.length > 0) {
    throw new FlashInputManifestError(
      'MISSING_REQUIRED_INPUT',
      `missing required flash input artifacts: ${missingRequired.join(', ')}`,
      missingRequired[0],
      [...missingRequired],
    );
  }

  const missingInputs: string[] = [];
  const warnings: string[] = [];
  const artifacts: Record<string, string> = {};
  const optionalInputs = optionalInputsForRun(opts.runDir);
  for (const [key, relativePath] of Object.entries(FLASH_INPUT_REQUIRED_INPUTS)) {
    artifacts[key] = relativePath;
  }
  for (const [key, relativePath] of Object.entries(optionalInputs)) {
    if (readSavedArtifact(opts.runDir, relativePath) === null) {
      missingInputs.push(relativePath);
      warnings.push(`optional flash input artifact not available: ${key} (${relativePath})`);
    } else {
      artifacts[key] = relativePath;
    }
  }

  // Determine created_at from run_manifest if available
  let createdAt = new Date().toISOString();
  try {
    const raw = readSavedArtifact(opts.runDir, FLASH_INPUT_REQUIRED_INPUTS.run_manifest);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.created_at === 'string') {
        createdAt = parsed.created_at;
      }
    }
  } catch {
    // keep default
  }

  return {
    run_id: opts.run_id,
    created_at: createdAt,
    task: opts.task,
    repo_root: opts.repo_root,
    required_inputs: { ...FLASH_INPUT_REQUIRED_INPUTS },
    optional_inputs: optionalInputs,
    missing_inputs: missingInputs,
    warnings,
    artifacts,
  };
}

/**
 * Resolve the absolute path of a flash artifact given a run directory and relative path.
 */
export function resolveFlashArtifactPath(runDir: string, relativePath: string): string {
  return path.join(runDir, relativePath);
}
