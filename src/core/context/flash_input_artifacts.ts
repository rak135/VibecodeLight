import * as fs from 'fs';
import * as path from 'path';

import type { TaskIntent } from '../../adapters/task_normalizer/types.js';
import { buildCompactFlashContext, type CompactFlashArtifacts } from './flash_compaction.js';
import { buildFlashInputManifest, type FlashInputManifest } from './flash_input_manifest.js';
import { formatPreviousRunSummary, getPreviousRunSummary } from './previous_run_summary.js';

export interface BuildAndWriteFlashInputArtifactsOptions {
  run_id: string;
  task: string;
  repo_root: string;
  runDir: string;
  flashDir: string;
  vibecodePath: string;
  taskIntent?: TaskIntent;
}

export interface BuildAndWriteFlashInputArtifactsResult {
  manifest: FlashInputManifest;
  compactResult: CompactFlashArtifacts;
  flashInputPath: string;
  flashInputManifestPath: string;
  repoAtlasPath: string;
  taskSlicePath: string;
  relevanceSelectionPath: string;
  flashInputBudgetPath: string;
  warnings: string[];
}

export function buildAndWriteFlashInputArtifacts(
  opts: BuildAndWriteFlashInputArtifactsOptions,
): BuildAndWriteFlashInputArtifactsResult {
  const manifest = buildFlashInputManifest({
    run_id: opts.run_id,
    task: opts.task,
    repo_root: opts.repo_root,
    runDir: opts.runDir,
  });
  const previousRunSummary = formatPreviousRunSummary(
    getPreviousRunSummary({
      vibecodePath: opts.vibecodePath,
      currentRunId: opts.run_id,
    }),
  );
  const compactResult = buildCompactFlashContext({
    run_id: opts.run_id,
    task: opts.task,
    repo_root: opts.repo_root,
    runDir: opts.runDir,
    previousRunSummary,
    taskIntent: opts.taskIntent,
  });
  const { paths: compactPaths } = compactResult;
  const flashInputManifestPath = path.join(opts.flashDir, 'flash_input_manifest.json');
  const flashInputPath = path.join(opts.flashDir, 'flash_input.md');
  const repoAtlasPath = compactPaths.repo_atlas_path ?? compactPaths.run_repo_atlas_path;
  const taskSlicePath = compactPaths.task_slice_path;
  const relevanceSelectionPath = compactPaths.relevance_selection_path;
  const flashInputBudgetPath = compactPaths.flash_input_budget_path;

  fs.writeFileSync(flashInputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(flashInputPath, compactResult.flashInput, 'utf8');

  return {
    manifest,
    compactResult,
    flashInputPath,
    flashInputManifestPath,
    repoAtlasPath,
    taskSlicePath,
    relevanceSelectionPath,
    flashInputBudgetPath,
    warnings: manifest.warnings,
  };
}
