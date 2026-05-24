import {
  buildFlashInputManifest,
  FlashInputManifest,
} from './flash_input_manifest.js';
import { buildCompactFlashContext } from './flash_compaction.js';

// Note: getPreviousRunSummary is called by the CLI/orchestrator and passed as previousRunSummary string.
// The builder only formats what it receives.

export interface BuildFlashInputOptions {
  run_id: string;
  task: string;
  repo_root: string;
  runDir: string;
  previousRunSummary?: string | undefined;
  manifest?: FlashInputManifest;
}

export function buildFlashInput(opts: BuildFlashInputOptions): string {
  // Validate the existing manifest contract first so missing required artifacts
  // keep the same structured diagnostics. The compact builder then consumes the
  // same saved scan artifacts and writes repo_atlas/task_slice/budget sidecars.
  opts.manifest ?? buildFlashInputManifest({
    run_id: opts.run_id,
    task: opts.task,
    repo_root: opts.repo_root,
    runDir: opts.runDir,
  });

  return buildCompactFlashContext({
    run_id: opts.run_id,
    task: opts.task,
    repo_root: opts.repo_root,
    runDir: opts.runDir,
    previousRunSummary: opts.previousRunSummary,
  }).flashInput;
}
