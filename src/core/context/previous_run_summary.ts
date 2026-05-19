import fs from 'fs';
import path from 'path';

export interface PreviousRunSummaryOptions {
  vibecodePath: string;
  currentRunId: string;
}

export interface PreviousRunInfo {
  run_id: string;
  task: string;
  created_at: string;
  status: string;
}

function readRunManifest(runDir: string): Record<string, unknown> | null {
  const manifestPath = path.join(runDir, 'run_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Get the most recent completed previous run (status: done) excluding the current run.
 * Returns PreviousRunInfo if found, undefined otherwise.
 */
export function getPreviousRunSummary(opts: PreviousRunSummaryOptions): PreviousRunInfo | undefined {
  const runsDir = path.join(opts.vibecodePath, 'runs');
  if (!fs.existsSync(runsDir)) {
    return undefined;
  }

  let runIds: string[];
  try {
    runIds = fs
      .readdirSync(runsDir)
      .filter((entry) => {
        try {
          return fs.statSync(path.join(runsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
  } catch {
    return undefined;
  }

  for (const runId of runIds) {
    if (runId === opts.currentRunId) {
      continue;
    }

    const manifest = readRunManifest(path.join(runsDir, runId));
    if (!manifest || manifest.status !== 'done') {
      continue;
    }

    return {
      run_id: String(manifest.run_id ?? runId),
      task: String(manifest.task ?? ''),
      created_at: String(manifest.created_at ?? ''),
      status: String(manifest.status ?? 'done'),
    };
  }

  return undefined;
}

/**
 * Format previous run info as a human-readable string for flash_input.md.
 */
export function formatPreviousRunSummary(info: PreviousRunInfo | undefined): string {
  if (!info) {
    return 'none available';
  }
  return [
    `run_id: ${info.run_id}`,
    `task: ${info.task}`,
    `created_at: ${info.created_at}`,
    `status: ${info.status}`,
  ].join('\n');
}
