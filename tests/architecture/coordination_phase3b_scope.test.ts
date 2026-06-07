import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * Phase 3B scope guard.
 *
 * Phase 3B adds the optional run/agent binding, the read-only coordination
 * prompt context, and the visible "# Multi-Agent Coordination" block. It is
 * intentionally advisory-only. These three source files must NOT pull in any of
 * the heavier, later-phase behavior (watchers, finalize/commit guards, git
 * mutation, handoff workflows, UI, hard source-file locks, or a coordination
 * config file). This test keeps the phase honest without being brittle.
 */

const repoRoot = path.resolve(__dirname, '../..');

const phase3bFiles = [
  path.join(repoRoot, 'src', 'core', 'coordination', 'agent_binding.ts'),
  path.join(repoRoot, 'src', 'core', 'coordination', 'prompt_context.ts'),
  path.join(repoRoot, 'src', 'core', 'prompting', 'coordination_section.ts'),
];

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

describe('Coordination Phase 3B scope boundary', () => {
  test('the Phase 3B source files exist', () => {
    for (const file of phase3bFiles) {
      expect(fs.existsSync(file), `${repoPath(file)} should exist`).toBe(true);
    }
  });

  test('Phase 3B does not introduce watchers, guards, git mutation, handoffs, UI, or hard locks', () => {
    // Patterns target real implementation constructs, not the visible advisory
    // disclaimers (e.g. the rendered coordination block's "never use git add -A"
    // or "Do not invent handoff commands"), which are allowed prose. The git
    // mutation rules therefore match argv literals (`'add', ...` / `'commit', …`)
    // — the form real execution would take — not documentation strings.
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'fs.watch', regex: /\bfs\.watch\s*\(/ },
      { label: 'watchFile', regex: /\bwatchFile\s*\(/ },
      { label: 'chokidar', regex: /\bchokidar\b/ },
      { label: 'finalize guard', regex: /finalize[A-Za-z]*Guard|[Gg]uard[A-Za-z]*Finalize/ },
      { label: 'commit guard', regex: /commit[A-Za-z]*Guard|[Gg]uard[A-Za-z]*Commit/ },
      { label: 'git add (argv)', regex: /['"]add['"]\s*,/ },
      { label: 'git commit (argv)', regex: /['"]commit['"]\s*,/ },
      { label: 'handoff implementation', regex: /handoff[A-Z_]|createHandoff|HandoffRecord|requestHandoff|acceptHandoff/ },
      { label: 'UI import', regex: /\b(react|electron)\b|from\s+['"][^'"]*desktop/i },
      { label: 'chmod', regex: /\bchmod(?:Sync)?\s*\(/ },
      { label: 'ACL/attrib/flock tooling', regex: /\bicacls\b|\battrib\b|\bflock\b|\btakeown\b/ },
      { label: 'lock-file write', regex: /writeFileSync\([^)]*\.lock|`[^`]*\.lock`/ },
      { label: 'coordination config file', regex: /coordination[\/\\]config\.json/ },
    ];

    const violations: string[] = [];
    for (const file of phase3bFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('Phase 3B source does not shell out (no new CLI/MCP claim or session tooling here)', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: "import 'child_process'", regex: /['"]node:child_process['"]|['"]child_process['"]/ },
      { label: 'spawn/exec', regex: /\bspawn\s*\(|\bspawnSync\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bexeca\s*\(/ },
    ];

    const violations: string[] = [];
    for (const file of phase3bFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
