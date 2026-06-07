import path from 'path';

import { ScannerConfig, ScannerConfigWithTaskIntent } from '../models/index.js';
import type { TaskIntent } from '../../adapters/task_normalizer/types.js';

export function buildScannerConfig(opts: {
  run_id: string;
  task: string;
  repo_root: string;
  out_dir: string;
}): ScannerConfig {
  return {
    run_id: opts.run_id,
    task: opts.task,
    repo_root: opts.repo_root,
    out_dir: opts.out_dir,
  };
}

export function buildScannerConfigPayload(
  base: ScannerConfig,
  taskIntent?: TaskIntent,
): ScannerConfigWithTaskIntent {
  const hasEnrichment = taskIntent?.enabled && taskIntent.ok;
  return {
    ...base,
    normalized_english_task: hasEnrichment ? taskIntent.normalized_english_task : '',
    search_hints: hasEnrichment ? taskIntent.search_hints : [],
    keyword_groups: hasEnrichment ? taskIntent.keyword_groups : {},
    _provenance_note: 'normalized signals from Task Normalizer; Python scanner uses these for expanded keyword matching',
  };
}

export function getScannerConfigPaths(repoRoot: string, runId: string) {
  const runRoot = path.join(repoRoot, '.vibecode', 'runs', runId);
  return {
    runRoot,
    scannerConfigPath: path.join(runRoot, 'scanner_config.json'),
    scanOutDir: path.join(runRoot, 'scan'),
  };
}
