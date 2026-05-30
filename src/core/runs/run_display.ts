import fs from 'fs';
import path from 'path';

import { CodeGraphStatus, readRunCodeGraphStatus } from '../scanning/codegraph_status.js';

export interface RunInfo {
  run_id: string;
  task: string;
  repo_root: string;
  created_at: string;
  runDir: string;
  artifacts: {
    user_prompt?: string;
    run_manifest?: string;
    scanner_config?: string;
    flash_input?: string;
    flash_output?: string;
    context_pack?: string;
    selected_skills?: string;
    final_prompt?: string;
    send_metadata?: string;
    codegraph_usage?: string;
    codegraph_context?: string;
    codegraph_repo_atlas?: string;
    codegraph_repo_atlas_json?: string;
    repo_atlas?: string;
    repo_atlas_json?: string;
  };
  has_final_prompt: boolean;
  has_send_metadata: boolean;
  /** Optional CodeGraph detect-only status, derived from scan/external_tools.json. */
  codegraph: CodeGraphStatus;
}

function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function existing(filePath: string): string | undefined {
  return fs.existsSync(filePath) ? filePath : undefined;
}

export function getRunInfo(runDir: string): RunInfo {
  const manifestPath = path.join(runDir, 'run_manifest.json');
  const scannerConfigPath = path.join(runDir, 'scanner_config.json');
  const manifest = readJson<Record<string, unknown>>(manifestPath) ?? {};
  const scannerConfig = readJson<Record<string, unknown>>(scannerConfigPath) ?? {};

  const run_id = String(manifest.run_id ?? path.basename(runDir));
  const task = String(manifest.task ?? manifest.task_raw ?? scannerConfig.task ?? '');
  const repo_root = String(manifest.repo_root ?? scannerConfig.repo_root ?? '');
  const created_at = String(manifest.created_at ?? '');

  const artifacts = {
    user_prompt: existing(path.join(runDir, 'user_prompt.md')),
    run_manifest: existing(manifestPath),
    scanner_config: existing(scannerConfigPath),
    flash_input: existing(path.join(runDir, 'flash', 'flash_input.md')),
    flash_output: existing(path.join(runDir, 'flash', 'flash_output.md')),
    context_pack: existing(path.join(runDir, 'output', 'context_pack.md')),
    selected_skills: existing(path.join(runDir, 'skills', 'selected_skills.json')),
    final_prompt: existing(path.join(runDir, 'output', 'final_prompt.md')),
    send_metadata: existing(path.join(runDir, 'terminal', 'send_metadata.json')),
    codegraph_usage: existing(path.join(runDir, 'scan', 'codegraph_usage.json')),
    codegraph_context: existing(path.join(runDir, 'scan', 'codegraph_context.md')),
    codegraph_repo_atlas: existing(path.join(runDir, 'scan', 'codegraph_repo_atlas.md')),
    codegraph_repo_atlas_json: existing(path.join(runDir, 'scan', 'codegraph_repo_atlas.json')),
    repo_atlas: existing(path.join(runDir, 'scan', 'repo_atlas.md')),
    repo_atlas_json: existing(path.join(runDir, 'scan', 'repo_atlas.json')),
  };

  return {
    run_id,
    task,
    repo_root,
    created_at,
    runDir,
    artifacts,
    has_final_prompt: artifacts.final_prompt !== undefined,
    has_send_metadata: artifacts.send_metadata !== undefined,
    codegraph: readRunCodeGraphStatus(runDir),
  };
}

export function listRuns(_vibecodePath: string, runsDir: string): RunInfo[] {
  if (!fs.existsSync(runsDir)) return [];
  const runDirs = fs
    .readdirSync(runsDir)
    .map((entry) => path.join(runsDir, entry))
    .filter((entryPath) => {
      try {
        return fs.statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    });

  return runDirs
    .map((runDir) => getRunInfo(runDir))
    .sort((a, b) => {
      const createdCompare = b.created_at.localeCompare(a.created_at);
      if (createdCompare !== 0) return createdCompare;
      return b.run_id.localeCompare(a.run_id);
    });
}
