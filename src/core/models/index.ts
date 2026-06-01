export interface RunManifest {
  run_id: string;
  created_at: string;
  task: string;
  status: 'created' | 'scanning' | 'done' | 'error';
}

export interface WorkspacePaths {
  root: string;
  vibecode: string;
  runs: string;
  current: string;
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

export type SkillSource = 'user-profile' | 'project';
export type SkillScope = 'default' | 'user' | 'project';

export interface SkillMetadata {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  source: SkillSource;
  scope: SkillScope;
  path: string;
  has_skill_md: boolean;
  has_skill_yaml: boolean;
  warnings: string[];
}

export interface SkillsCatalog {
  generated_at: string;
  skills: SkillMetadata[];
  warnings: string[];
}
