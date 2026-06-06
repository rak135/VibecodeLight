import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * Characterization/architecture guard: the CLI structured-error type must have a
 * single source of truth. `CliStructuredError` may be declared only in the
 * canonical helper module; command files import it, never re-declare it.
 */

const repoRoot = path.resolve(__dirname, '../..');
const cliRoot = path.join(repoRoot, 'src', 'app', 'cli');
const canonicalModule = path.join(cliRoot, 'structured_output.ts');

function collectFiles(dir: string, extension = '.ts'): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath, extension));
    else if (entry.isFile() && fullPath.endsWith(extension)) files.push(fullPath);
  }
  return files;
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

// Matches a local declaration of the type, e.g. `interface CliStructuredError {`
// or `type CliStructuredError = …`. Deliberately does NOT match import-specifier
// references such as `import { type CliStructuredError } from …` (where the name
// is followed by `,` or `}`), which are allowed.
const DECLARATION = /\binterface\s+CliStructuredError\b|\btype\s+CliStructuredError\s*=/;

describe('CLI structured error single source of truth', () => {
  test('CliStructuredError is declared in exactly one CLI module (the canonical helper)', () => {
    const cliFiles = collectFiles(cliRoot);
    expect(cliFiles.length).toBeGreaterThan(0);

    const declaringFiles = cliFiles.filter((file) => DECLARATION.test(read(file))).map(repoPath).sort();
    expect(declaringFiles).toEqual([repoPath(canonicalModule)]);
  });

  test('the canonical helper exports CliStructuredError and the error helpers', () => {
    const source = read(canonicalModule);
    expect(source).toMatch(/export\s+interface\s+CliStructuredError\b/);
    expect(source).toMatch(/export\s+function\s+makeCliStructuredError\b/);
    expect(source).toMatch(/export\s+function\s+emitCliStructuredError\b/);
  });

  test('command files that use CliStructuredError import it rather than re-declaring it', () => {
    const commandFiles = collectFiles(path.join(cliRoot, 'commands'));
    for (const file of commandFiles) {
      const source = read(file);
      if (!source.includes('CliStructuredError')) continue;
      // Must not declare it locally...
      expect(DECLARATION.test(source)).toBe(false);
      // ...and must import it from the canonical helper module.
      expect(source).toMatch(/from ['"][^'"]*structured_output\.js['"]/);
    }
  });
});
