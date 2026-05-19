import fs from 'fs';
import path from 'path';

/**
 * Reads a saved artifact file relative to a run directory.
 * Returns the file content as a string, or null if the file does not exist.
 */
export function readSavedArtifact(runDir: string, relativePath: string): string | null {
  const fullPath = path.join(runDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Checks whether an artifact exists.
 */
export function artifactExists(runDir: string, relativePath: string): boolean {
  return fs.existsSync(path.join(runDir, relativePath));
}
