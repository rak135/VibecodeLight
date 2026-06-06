import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * Characterization tests for the MCP <-> CLI dependency direction.
 *
 * Target architecture (Option C in docs/ARCHITECTURE_DECISIONS.md): shared
 * core/services with thin MCP and CLI adapters. The invariants pinned here:
 *
 *   1. No file under src/app/mcp imports from src/app/cli.
 *   2. No file under src/app/mcp/tools shells out to the `vibecode` CLI
 *      (no child_process / spawn / exec / execa process primitives).
 *   3. The CLI may start/install MCP via the MCP entrypoint (src/app/mcp/index)
 *      but must not reach into individual MCP tool modules.
 *
 * These tests describe current reality. They do not refactor production code.
 */

const repoRoot = path.resolve(__dirname, '../..');
const mcpRoot = path.join(repoRoot, 'src', 'app', 'mcp');
const mcpToolsRoot = path.join(mcpRoot, 'tools');
const mcpIndex = path.join(mcpRoot, 'index');
const cliRoot = path.join(repoRoot, 'src', 'app', 'cli');

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

/**
 * Extract every module specifier referenced by static imports, side-effect
 * imports, dynamic imports, and require() calls. Both relative and package
 * specifiers are returned verbatim.
 */
function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Resolve a relative specifier to an extension-stripped absolute path. Returns
 * null for package (non-relative) specifiers, which can never point at a sibling
 * app layer in this repo.
 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return resolved.replace(/\.js$/, '').replace(/\.ts$/, '');
}

function isUnder(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

describe('MCP <-> CLI dependency direction', () => {
  test('no file under src/app/mcp imports from src/app/cli', () => {
    const mcpFiles = collectFiles(mcpRoot);
    expect(mcpFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of mcpFiles) {
      for (const specifier of extractSpecifiers(read(file))) {
        const resolved = resolveRelative(file, specifier);
        const crossesViaRelative = resolved !== null && isUnder(cliRoot, resolved);
        const crossesViaAlias = /app\/cli(?:\/|['"]|$)/.test(specifier);
        if (crossesViaRelative || crossesViaAlias) {
          violations.push(`${repoPath(file)} :: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('no file under src/app/mcp/tools shells out to a child process', () => {
    const toolFiles = collectFiles(mcpToolsRoot);
    expect(toolFiles.length).toBeGreaterThan(0);

    // Process-spawning primitives. We intentionally do NOT forbid the literal
    // string "vibecode " here: MCP tool descriptions and guidance text legitimately
    // mention `vibecode codegraph …` / `vibecode runs …` as the CLI fallback for
    // non-MCP agents. A shell-out would require one of these primitives, none of
    // which appear in guidance prose.
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: "import 'child_process'", regex: /['"]node:child_process['"]|['"]child_process['"]/ },
      { label: 'spawnSync(', regex: /\bspawnSync\s*\(/ },
      { label: 'spawn(', regex: /\bspawn\s*\(/ },
      { label: 'execFileSync(', regex: /\bexecFileSync\s*\(/ },
      { label: 'execFile(', regex: /\bexecFile\s*\(/ },
      { label: 'execSync(', regex: /\bexecSync\s*\(/ },
      { label: 'exec(', regex: /\bexec\s*\(/ },
      { label: 'execa(', regex: /\bexeca\s*\(/ },
    ];

    const violations: string[] = [];
    for (const file of toolFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('the whole src/app/mcp tree never imports node:child_process', () => {
    const mcpFiles = collectFiles(mcpRoot);
    const offenders = mcpFiles
      .filter((file) => /['"]node:child_process['"]|['"]child_process['"]/.test(read(file)))
      .map(repoPath);
    expect(offenders).toEqual([]);
  });

  test('CLI mcp command imports the MCP server factory only via src/app/mcp/index', () => {
    const mcpCommand = path.join(cliRoot, 'commands', 'mcp.ts');
    const specifiers = extractSpecifiers(read(mcpCommand))
      .map((specifier) => ({ specifier, resolved: resolveRelative(mcpCommand, specifier) }))
      .filter((entry) => entry.resolved !== null && isUnder(mcpRoot, entry.resolved));

    // It does import the MCP layer...
    expect(specifiers.length).toBeGreaterThan(0);
    // ...and every MCP import it makes resolves to the public index entrypoint,
    // never to an internal tool module or server file.
    for (const entry of specifiers) {
      expect(entry.resolved).toBe(mcpIndex);
    }
  });

  test('no file under src/app/cli imports from src/app/mcp/tools', () => {
    const cliFiles = collectFiles(cliRoot);
    expect(cliFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of cliFiles) {
      for (const specifier of extractSpecifiers(read(file))) {
        const resolved = resolveRelative(file, specifier);
        const crossesViaRelative = resolved !== null && isUnder(mcpToolsRoot, resolved);
        const crossesViaAlias = /app\/mcp\/tools(?:\/|['"]|$)/.test(specifier);
        if (crossesViaRelative || crossesViaAlias) {
          violations.push(`${repoPath(file)} :: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
