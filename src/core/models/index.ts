export interface RunManifest {
  run_id: string;
  created_at: string;
  task: string;
  status: 'created' | 'scanning' | 'done' | 'error';
}

export interface WorkspaceConfig {
  project?: string;
  scanner?: Record<string, unknown>;
}

export interface WorkspacePaths {
  root: string;
  vibecode: string;
  runs: string;
  current: string;
  config: string;
  gitignore: string;
}

export interface ScannerConfig {
  run_id: string;
  task: string;
  repo_root: string;
  out_dir: string;
}

export interface InitResult {
  created: string[];
  existing: string[];
}
