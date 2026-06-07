import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * Phase 4A scope guard.
 *
 * Phase 4A adds a read-only, agent-aware finalize CHECK (core service + a thin
 * CLI command + a thin MCP tool). It classifies the dirty working tree relative
 * to a resolved agent's active advisory claims. It must stay strictly read-only
 * and must NOT pull in later-phase behavior: git mutation, a commit guard, a
 * file watcher, a handoff workflow, UI, source-file locks, or any filesystem
 * writes. This test keeps the phase honest without being brittle.
 */

const repoRoot = path.resolve(__dirname, '../..');

const phase4aFiles = [
  path.join(repoRoot, 'src', 'core', 'coordination', 'finalize_check.ts'),
  path.join(repoRoot, 'src', 'app', 'cli', 'commands', 'finalize.ts'),
  path.join(repoRoot, 'src', 'app', 'mcp', 'tools', 'finalize_check.ts'),
];

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

describe('Coordination Phase 4A scope boundary', () => {
  test('the Phase 4A source files exist', () => {
    for (const file of phase4aFiles) {
      expect(fs.existsSync(file), `${repoPath(file)} should exist`).toBe(true);
    }
  });

  test('Phase 4A introduces no git mutation, watcher, guard, handoff, UI, locks, or shell-out', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'child_process import', regex: /['"]node:child_process['"]|['"]child_process['"]/ },
      { label: 'spawn/exec', regex: /\bspawn\s*\(|\bspawnSync\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bexeca\s*\(/ },
      { label: 'fs.watch', regex: /\bfs\.watch\s*\(/ },
      { label: 'watchFile', regex: /\bwatchFile\s*\(/ },
      { label: 'chokidar', regex: /\bchokidar\b/ },
      { label: 'commit guard', regex: /commit[A-Za-z]*Guard|[Gg]uard[A-Za-z]*Commit/ },
      { label: 'finalize guard identifier', regex: /finalize[A-Za-z]*Guard|[Gg]uard[A-Za-z]*Finalize/ },
      { label: 'git add', regex: /['"]add['"]|git\s+add\b/ },
      { label: 'git commit', regex: /['"]commit['"]|git\s+commit\b/ },
      { label: 'git reset/stash/checkout', regex: /['"]reset['"]|['"]stash['"]|['"]checkout['"]/ },
      { label: 'handoff implementation', regex: /handoff[A-Z_]|createHandoff|HandoffRecord|requestHandoff|acceptHandoff/ },
      { label: 'UI import', regex: /\b(react|electron)\b|from\s+['"][^'"]*desktop/i },
      { label: 'chmod', regex: /\bchmod(?:Sync)?\s*\(/ },
      { label: 'ACL/attrib/flock tooling', regex: /\bicacls\b|\battrib\b|\bflock\b|\btakeown\b/ },
      { label: 'lock-file write', regex: /writeFileSync\([^)]*\.lock|`[^`]*\.lock`/ },
    ];

    const violations: string[] = [];
    for (const file of phase4aFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('Phase 4A finalize files perform no filesystem writes (read-only)', () => {
    const writeOps = /\bfs\.(writeFileSync|writeFile|appendFileSync|mkdirSync|rmSync|unlinkSync|rmdirSync|createWriteStream)\s*\(/;
    const violations: string[] = [];
    for (const file of phase4aFiles) {
      if (writeOps.test(read(file))) violations.push(repoPath(file));
    }
    expect(violations).toEqual([]);
  });
});
