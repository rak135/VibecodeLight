import fs from 'fs';
import path from 'path';

import { buildScannerConfig } from '../scanning/scanner_config.js';
import { generateRunId } from './run_id.js';
import { RunManifest } from '../models/index.js';

export async function createRun(opts: {
  vibecodePath: string;
  task: string;
  repoRoot: string;
}): Promise<{ run_id: string; runDir: string; scanDir: string }> {
  const run_id = generateRunId();
  const runDir = path.join(opts.vibecodePath, 'runs', run_id);
  const scanDir = path.join(runDir, 'scan');
  fs.mkdirSync(scanDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), `${opts.task}\n`, 'utf8');

  const manifest: RunManifest = {
    run_id,
    created_at: new Date().toISOString(),
    task: opts.task,
    status: 'created',
  };
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const scannerConfig = buildScannerConfig({
    run_id,
    task: opts.task,
    repo_root: opts.repoRoot,
    out_dir: 'scan',
  });
  fs.writeFileSync(path.join(runDir, 'scanner_config.json'), `${JSON.stringify(scannerConfig, null, 2)}\n`, 'utf8');

  return { run_id, runDir, scanDir };
}
