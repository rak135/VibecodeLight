import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const coordinationRoot = path.join(repoRoot, 'src', 'core', 'coordination');
const claimsAdapters = [
  path.join(repoRoot, 'src', 'app', 'cli', 'commands', 'claims.ts'),
  path.join(repoRoot, 'src', 'app', 'mcp', 'tools', 'claims.ts'),
];

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

describe('Coordination Phase 3A scope boundary', () => {
  test('coordination core does not introduce watchers, guards, hard locks, or source-file permission controls', () => {
    const files = collectFiles(coordinationRoot);
    expect(files.length).toBeGreaterThan(0);

    // Phase 4D intentionally adds exactly ONE live fs.watch watcher
    // (`live_watcher.ts`), superseding the original Phase 3A "no watcher
    // anywhere" invariant. The live-watch rules below are therefore exempted for
    // that single file (its non-enforcing scope is pinned by the Phase 4D scope
    // test); every other guard/lock/permission rule still applies to it.
    const liveWatcherFile = path.join(coordinationRoot, 'live_watcher.ts');
    const liveWatchLabels = new Set(['fs.watch', 'watchFile', 'chokidar']);

    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: 'fs.watch', regex: /\bfs\.watch\s*\(/ },
      { label: 'watchFile', regex: /\bwatchFile\s*\(/ },
      { label: 'chokidar', regex: /\bchokidar\b/ },
      { label: 'commit guard', regex: /\bcommit[A-Za-z]*Guard\b|\bguard[A-Za-z]*Commit\b/ },
      { label: 'finalize guard', regex: /\bfinalize[A-Za-z]*Guard\b|\bguard[A-Za-z]*Finalize\b/ },
      { label: 'chmod', regex: /\bchmod(?:Sync)?\s*\(/ },
      { label: 'ACL tooling', regex: /\bicacls\b|\btakeown\b/ },
      { label: 'lock-file write', regex: /writeFileSync\([^)]*\.lock|`[^`]*\.lock`/ },
      { label: 'coordination config write', regex: /writeFileSync\([^)]*coordination[^)]*config\.json/ },
    ];

    const violations: string[] = [];
    for (const file of files) {
      const source = read(file);
      const isLiveWatcher = path.resolve(file) === path.resolve(liveWatcherFile);
      for (const rule of forbidden) {
        if (isLiveWatcher && liveWatchLabels.has(rule.label)) continue;
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('Phase 3A claim adapters do not shell out or implement conflict/handoff workflows', () => {
    const forbidden: Array<{ label: string; regex: RegExp }> = [
      { label: "import 'child_process'", regex: /['"]node:child_process['"]|['"]child_process['"]/ },
      { label: 'spawn/exec', regex: /\bspawn\s*\(|\bspawnSync\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bexeca\s*\(/ },
      { label: 'conflict record persistence', regex: /\bConflictRecord\b|conflicts:\s*\[[^\]]+claim/i },
      { label: 'handoff workflow', regex: /\bHandoff\b|\bhandoff[A-Z_]/ },
    ];

    const violations: string[] = [];
    for (const file of claimsAdapters) {
      const source = read(file);
      for (const rule of forbidden) {
        if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('only the Phase 5A read-only observability surface references coordination on the desktop', () => {
    // Phase 3A forbade ANY desktop coordination/claims surface. Phase 5A
    // intentionally introduces a READ-ONLY coordination observability panel
    // (visibility only — no claim add/release/reap, conflict resolve, commit,
    // git, or watcher control), so the original "no panel" rule is narrowed
    // rather than dropped: the only desktop files that may reference
    // coordination/claims are the known read-only Phase 5A set below. The
    // read-only scope of those files is pinned by
    // tests/app/desktop/coordination_scope.test.ts.
    const allowed = new Set([
      'src/app/desktop/coordination_bridge.ts',
      'src/app/desktop/preload.ts',
      'src/app/desktop/renderer/coordination_panel.d.ts',
    ]);
    const desktopFiles = collectFiles(path.join(repoRoot, 'src', 'app', 'desktop'));
    const offenders = desktopFiles
      .filter((file) => /\bcoordination\b|\bclaim(s)?\b/i.test(read(file)))
      .map(repoPath)
      .filter((rel) => !allowed.has(rel));
    expect(offenders).toEqual([]);
  });
});
