import fs from 'fs';
import YAML from 'yaml';

import { InitResult, WorkspaceConfig } from '../models/index.js';
import { ensureLocalConfig } from '../config/index.js';
import { getWorkspacePaths } from './paths.js';

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export async function initWorkspace(root: string): Promise<InitResult> {
  const paths = getWorkspacePaths(root);
  const created: string[] = [];
  const existing: string[] = [];

  if (fs.existsSync(paths.vibecode)) {
    pushUnique(existing, '.vibecode');
  } else {
    fs.mkdirSync(paths.vibecode, { recursive: true });
    pushUnique(created, '.vibecode');
  }

  if (fs.existsSync(paths.runs)) {
    pushUnique(existing, '.vibecode/runs');
  } else {
    fs.mkdirSync(paths.runs, { recursive: true });
    pushUnique(created, '.vibecode/runs');
  }

  if (fs.existsSync(paths.current)) {
    pushUnique(existing, '.vibecode/current');
  } else {
    fs.mkdirSync(paths.current, { recursive: true });
    pushUnique(created, '.vibecode/current');
  }

  if (fs.existsSync(paths.config)) {
    pushUnique(existing, 'config.yaml');
  } else {
    const defaultConfig: WorkspaceConfig = { project: 'vibecode-light' };
    fs.writeFileSync(paths.config, YAML.stringify(defaultConfig), 'utf8');
    pushUnique(created, 'config.yaml');
  }

  // Local workspace config (.vibecode/config.yaml): snapshot from the global
  // config when present, otherwise minimal safe defaults. Never overwrites an
  // existing local config (that requires explicit sync).
  const localConfig = ensureLocalConfig({ repoRoot: root, env: process.env });
  if (localConfig.created) {
    pushUnique(created, '.vibecode/config.yaml');
  } else {
    pushUnique(existing, '.vibecode/config.yaml');
  }

  let gitignoreContent = '';
  if (fs.existsSync(paths.gitignore)) {
    gitignoreContent = fs.readFileSync(paths.gitignore, 'utf8');
    pushUnique(existing, '.gitignore');
  } else {
    pushUnique(created, '.gitignore');
  }

  // Generated/external state that must be ignored by git. `.codegraph/` is
  // external CodeGraph index state, ignored alongside `.vibecode/`. Each entry
  // is appended only when missing, so re-running init is idempotent.
  let nextGitignore = gitignoreContent;
  for (const entry of ['.vibecode/', '.codegraph/']) {
    if (!nextGitignore.split(/\r?\n/).some((line) => line.trim() === entry)) {
      const trimmed = nextGitignore.trimEnd();
      nextGitignore = `${trimmed}${trimmed ? '\n' : ''}${entry}\n`;
    }
  }
  if (nextGitignore !== gitignoreContent) {
    fs.writeFileSync(paths.gitignore, nextGitignore, 'utf8');
  }

  return { created, existing };
}
