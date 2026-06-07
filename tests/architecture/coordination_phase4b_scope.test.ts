import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { buildVibecodeMcpTools, VIBECODE_MCP_TOOL_NAMES } from '../../src/app/mcp/index.js';

/**
 * Phase 4B scope guard.
 *
 * Phase 4B adds the first git-MUTATING coordination behavior: a scoped commit
 * guard (core + git mutation adapter + a thin CLI command). All mutation must be
 * narrow and explicit. This test pins that the new files never use broad staging
 * (`git add -A` / `git add .`) and never reset/stash/clean/checkout/restore, and
 * that no watcher / handoff / UI / source-lock behavior sneaks in. It also pins
 * the deliberate decision that the commit guard is CLI-ONLY — VibecodeMCP has
 * no git/source/commit mutation tool.
 */

const repoRoot = path.resolve(__dirname, '../..');

const phase4bFiles = [
  path.join(repoRoot, 'src', 'core', 'coordination', 'commit_guard.ts'),
  path.join(repoRoot, 'src', 'core', 'workspace', 'git_commit.ts'),
  path.join(repoRoot, 'src', 'app', 'cli', 'commands', 'commit.ts'),
];

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

describe('Coordination Phase 4B scope boundary', () => {
  test('the Phase 4B source files exist', () => {
    for (const file of phase4bFiles) {
      expect(fs.existsSync(file), `${repoPath(file)} should exist`).toBe(true);
    }
  });

  test('no broad staging and no reset/stash/clean/checkout/restore', () => {
    // Rules target real argv literals only, NOT the visible prose that documents
    // the prohibition (e.g. the comment "never `git add -A`") or the rejection
    // guard's `p === '-A'` / `p === '.'` checks.
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'git add -A (argv)', regex: /['"]add['"]\s*,\s*['"]-A['"]/ },
      { label: 'git add . (argv)', regex: /['"]add['"]\s*,\s*['"]\.['"]/ },
      { label: 'git add --all (argv)', regex: /['"]add['"]\s*,\s*['"]--?all['"]/ },
      { label: 'git reset (argv)', regex: /['"]reset['"]/ },
      { label: 'git stash (argv)', regex: /['"]stash['"]/ },
      { label: 'git clean (argv)', regex: /['"]clean['"]/ },
      { label: 'git checkout (argv)', regex: /['"]checkout['"]/ },
      { label: 'git restore (argv)', regex: /['"]restore['"]/ },
    ];

    const violations: string[] = [];
    for (const file of phase4bFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('staging always uses an explicit `--` pathspec separator', () => {
    const gitCommit = read(path.join(repoRoot, 'src', 'core', 'workspace', 'git_commit.ts'));
    expect(gitCommit).toMatch(/['"]add['"]\s*,\s*['"]--['"]/);
  });

  test('no watcher, handoff, UI, or source-lock behavior', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'fs.watch', regex: /\bfs\.watch\s*\(/ },
      { label: 'watchFile', regex: /\bwatchFile\s*\(/ },
      { label: 'chokidar', regex: /\bchokidar\b/ },
      { label: 'handoff implementation', regex: /handoff[A-Z_]|createHandoff|HandoffRecord|requestHandoff|acceptHandoff/ },
      { label: 'UI import', regex: /\b(react|electron)\b|from\s+['"][^'"]*desktop/i },
      { label: 'chmod', regex: /\bchmod(?:Sync)?\s*\(/ },
      { label: 'ACL/attrib/flock tooling', regex: /\bicacls\b|\battrib\b|\bflock\b|\btakeown\b/ },
      { label: 'lock-file write', regex: /writeFileSync\([^)]*\.lock|`[^`]*\.lock`/ },
    ];

    const violations: string[] = [];
    for (const file of phase4bFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('commit guard is CLI-only: VibecodeMCP exposes no commit/mutation tool', () => {
    const tools = buildVibecodeMcpTools();
    // Phase 4B added no MCP tool (commit guard is CLI-only). The registry has
    // since grown with Phase 4C watcher evidence tools (29), but it still
    // exposes NO commit/guard mutation tool — which is what this pins.
    expect(tools).toHaveLength(VIBECODE_MCP_TOOL_NAMES.length);
    for (const name of VIBECODE_MCP_TOOL_NAMES) {
      expect(name).not.toMatch(/commit|guard/i);
    }
    expect(VIBECODE_MCP_TOOL_NAMES).not.toContain('vibecode_commit_guard');
  });
});
