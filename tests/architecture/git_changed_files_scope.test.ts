import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * Phase 4A-prep scope guard.
 *
 * This prep phase adds ONE read-only git changed-files adapter that future
 * finalize/commit guards will consume. The adapter must stay strictly
 * read-only and must NOT smuggle in any later-phase behavior: git mutation,
 * watchers, finalize/commit guards, handoff workflows, UI, or hard
 * source-file locks. This test keeps the prep phase honest without being
 * brittle.
 */

const repoRoot = path.resolve(__dirname, '../..');

const phase4aPrepFiles = [
  path.join(repoRoot, 'src', 'core', 'workspace', 'git_changed_files.ts'),
];

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

describe('Phase 4A-prep git changed-files scope boundary', () => {
  test('the adapter source file exists', () => {
    for (const file of phase4aPrepFiles) {
      expect(fs.existsSync(file), `${repoPath(file)} should exist`).toBe(true);
    }
  });

  test('the adapter only ever references read-only git subcommands', () => {
    // Mutating git subcommands as quoted arg literals. `'added'` (a status
    // label) intentionally does NOT match `'add'`.
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'git add', regex: /['"]add['"]/ },
      { label: 'git commit', regex: /['"]commit['"]/ },
      { label: 'git reset', regex: /['"]reset['"]/ },
      { label: 'git stash', regex: /['"]stash['"]/ },
      { label: 'git checkout', regex: /['"]checkout['"]/ },
      { label: 'git restore', regex: /['"]restore['"]/ },
      { label: 'git rm', regex: /['"]rm['"]/ },
      { label: 'git clean', regex: /['"]clean['"]/ },
      { label: 'git mv', regex: /['"]mv['"]/ },
      { label: 'git apply', regex: /['"]apply['"]/ },
    ];

    const violations: string[] = [];
    for (const file of phase4aPrepFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('the adapter does not introduce watchers, guards, handoffs, UI, or hard locks', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'fs.watch', regex: /\bfs\.watch\s*\(/ },
      { label: 'watchFile', regex: /\bwatchFile\s*\(/ },
      { label: 'chokidar', regex: /\bchokidar\b/ },
      { label: 'finalize guard', regex: /finalize[A-Za-z]*Guard|[Gg]uard[A-Za-z]*Finalize/ },
      { label: 'commit guard', regex: /commit[A-Za-z]*Guard|[Gg]uard[A-Za-z]*Commit/ },
      { label: 'handoff implementation', regex: /handoff[A-Z_]|createHandoff|HandoffRecord|requestHandoff|acceptHandoff/ },
      { label: 'UI import', regex: /\b(react|electron)\b|from\s+['"][^'"]*desktop/i },
      { label: 'chmod', regex: /\bchmod(?:Sync)?\s*\(/ },
      { label: 'ACL/attrib/flock tooling', regex: /\bicacls\b|\battrib\b|\bflock\b|\btakeown\b/ },
      { label: 'lock-file write', regex: /writeFileSync\([^)]*\.lock|`[^`]*\.lock`/ },
    ];

    const violations: string[] = [];
    for (const file of phase4aPrepFiles) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
