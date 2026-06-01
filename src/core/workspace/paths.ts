import path from 'path';
import { WorkspacePaths } from '../models/index.js';

export function getWorkspacePaths(root: string): WorkspacePaths {
  const vibecode = path.join(root, '.vibecode');
  return {
    root,
    vibecode,
    runs: path.join(vibecode, 'runs'),
    current: path.join(vibecode, 'current'),
    gitignore: path.join(root, '.gitignore'),
  };
}
