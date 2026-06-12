import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { buildVibecodeMcpTools, VIBECODE_MCP_TOOL_NAMES } from '../../src/app/mcp/index.js';

/**
 * Phase 4C scope guard.
 *
 * Phase 4C adds a NON-ENFORCING watcher evidence layer: a shared classification
 * primitive, an append-only evidence log, a manual-scan service, and read/scan
 * CLI + MCP surfaces. This test pins that the new code stays within scope:
 *   - it never mutates git (no add/commit/reset/stash/clean/checkout/restore),
 *   - it never locks/chmods/ACLs source files,
 *   - it ships NO live fs.watch/chokidar watcher yet (deferred to a later phase),
 *   - it adds no handoff / UI / validation-runner behavior,
 *   - MCP exposes exactly two evidence tools (list read-only, scan generated-state
 *     only) and still NO commit/guard/source-mutation tool.
 */

const repoRoot = path.resolve(__dirname, '../..');

const phase4cFiles = [
  path.join(repoRoot, 'src', 'core', 'coordination', 'path_classification.ts'),
  path.join(repoRoot, 'src', 'core', 'coordination', 'watcher.ts'),
  path.join(repoRoot, 'src', 'core', 'coordination', 'watcher_events.ts'),
  path.join(repoRoot, 'src', 'app', 'cli', 'commands', 'evidence.ts'),
  path.join(repoRoot, 'src', 'app', 'mcp', 'tools', 'evidence.ts'),
];

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

describe('Coordination Phase 4C scope boundary', () => {
  test('the Phase 4C source files exist', () => {
    for (const file of phase4cFiles) {
      expect(fs.existsSync(file), `${repoPath(file)} should exist`).toBe(true);
    }
  });

  test('no git mutation: no add/commit/reset/stash/clean/checkout/restore argv', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'git add (argv)', regex: /['"]add['"]\s*,/ },
      { label: 'git commit (argv)', regex: /['"]commit['"]/ },
      { label: 'git reset (argv)', regex: /['"]reset['"]/ },
      { label: 'git stash (argv)', regex: /['"]stash['"]/ },
      { label: 'git clean (argv)', regex: /['"]clean['"]/ },
      { label: 'git checkout (argv)', regex: /['"]checkout['"]/ },
      { label: 'git restore (argv)', regex: /['"]restore['"]/ },
    ];
    const violations: string[] = [];
    for (const file of phase4cFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('no source-file locks, chmod/ACL tooling, or lock-file writes', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'chmod', regex: /\bchmod(?:Sync)?\s*\(/ },
      { label: 'ACL/attrib/flock tooling', regex: /\bicacls\b|\battrib\b|\bflock\b|\btakeown\b/ },
      { label: 'lock-file write', regex: /writeFileSync\([^)]*\.lock|`[^`]*\.lock`/ },
    ];
    const violations: string[] = [];
    for (const file of phase4cFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('Phase 4C ships no live fs.watch/chokidar watcher (manual-scan foundation only)', () => {
    // Rules target real usage (calls / imports), NOT the prose comments that
    // document the deferral of a live watcher to a later phase.
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'fs.watch call', regex: /\bfs\.watch\s*\(/ },
      { label: 'watchFile call', regex: /\bwatchFile\s*\(/ },
      { label: 'chokidar import', regex: /from\s+['"]chokidar['"]|require\(\s*['"]chokidar['"]\s*\)/ },
    ];
    const violations: string[] = [];
    for (const file of phase4cFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('no handoff, UI, or validation-runner behavior', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'handoff implementation', regex: /handoff[A-Z_]|createHandoff|HandoffRecord|requestHandoff|acceptHandoff/ },
      { label: 'UI import', regex: /\b(react|electron)\b|from\s+['"][^'"]*desktop/i },
      { label: 'validation runner', regex: /runValidation|validation_runner|ValidationRunner/ },
    ];
    const violations: string[] = [];
    for (const file of phase4cFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('evidence is written only to the generated coordination events log', () => {
    // The only file-writing module is watcher_events.ts and it writes solely the
    // generated events.jsonl under .vibecode/coordination/.
    const watcher = read(path.join(repoRoot, 'src', 'core', 'coordination', 'watcher.ts'));
    expect(watcher).not.toMatch(/writeFileSync|appendFileSync/);
    const store = read(path.join(repoRoot, 'src', 'core', 'coordination', 'watcher_events.ts'));
    expect(store).toContain("'events.jsonl'");
    expect(store).toContain('getCoordinationPaths');
  });

  test('MCP v1 does not expose old evidence tools or commit/guard/source-mutation tools', () => {
    const tools = buildVibecodeMcpTools();
    expect(tools).toHaveLength(VIBECODE_MCP_TOOL_NAMES.length);
    const evidenceTools = VIBECODE_MCP_TOOL_NAMES.filter((n) => n.includes('evidence'));
    expect(evidenceTools).toEqual([]);
    for (const name of VIBECODE_MCP_TOOL_NAMES) {
      expect(name).not.toMatch(/commit|guard/i);
      expect(name).not.toMatch(/(write|create|update|delete|put|post|set|edit|modify)/i);
    }
  });
});
