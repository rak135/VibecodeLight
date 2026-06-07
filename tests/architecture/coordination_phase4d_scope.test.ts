import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { buildVibecodeMcpTools, VIBECODE_MCP_TOOL_NAMES } from '../../src/app/mcp/index.js';

/**
 * Phase 4D scope guard.
 *
 * Phase 4D adds a LIVE watcher lifecycle over the Phase 4C evidence layer. The
 * live watcher may now use a real fs.watch backend (that is the whole point of
 * the phase), but it must stay non-enforcing: it records advisory evidence only.
 * This test pins that the new code:
 *   - never mutates git (no add/commit/reset/stash/clean/checkout/restore),
 *   - never locks/chmods/ACLs source files,
 *   - never creates/resolves claims automatically,
 *   - adds no handoff / UI / validation-runner behavior,
 *   - writes no source files or git state (evidence goes only through the
 *     Phase 4C event core),
 *   - adds NO MCP live-watch start/stop control tool (the registry is unchanged
 *     at 29 tools; MCP keeps only the read-only list / generated-state scan).
 */

const repoRoot = path.resolve(__dirname, '../..');

const phase4dFiles = [
  path.join(repoRoot, 'src', 'core', 'coordination', 'live_watcher.ts'),
  path.join(repoRoot, 'src', 'app', 'cli', 'commands', 'evidence.ts'),
];

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function findViolations(rules: Array<{ label: string; regex: RegExp }>): string[] {
  const violations: string[] = [];
  for (const file of phase4dFiles) {
    const source = read(file);
    for (const rule of rules) {
      if (rule.regex.test(source)) violations.push(`${repoPath(file)} :: ${rule.label}`);
    }
  }
  return violations;
}

describe('Coordination Phase 4D scope boundary', () => {
  test('the Phase 4D source files exist', () => {
    for (const file of phase4dFiles) {
      expect(fs.existsSync(file), `${repoPath(file)} should exist`).toBe(true);
    }
  });

  test('no git mutation: no add/commit/reset/stash/clean/checkout/restore argv', () => {
    expect(
      findViolations([
        { label: 'git add (argv)', regex: /['"]add['"]\s*,/ },
        { label: 'git commit (argv)', regex: /['"]commit['"]/ },
        { label: 'git reset (argv)', regex: /['"]reset['"]/ },
        { label: 'git stash (argv)', regex: /['"]stash['"]/ },
        { label: 'git clean (argv)', regex: /['"]clean['"]/ },
        { label: 'git checkout (argv)', regex: /['"]checkout['"]/ },
        { label: 'git restore (argv)', regex: /['"]restore['"]/ },
      ]),
    ).toEqual([]);
  });

  test('no source-file locks, chmod/ACL tooling, or lock-file writes', () => {
    expect(
      findViolations([
        { label: 'chmod', regex: /\bchmod(?:Sync)?\s*\(/ },
        { label: 'ACL/attrib/flock tooling', regex: /\bicacls\b|\battrib\b|\bflock\b|\btakeown\b/ },
        { label: 'lock-file write', regex: /writeFileSync\([^)]*\.lock|`[^`]*\.lock`/ },
      ]),
    ).toEqual([]);
  });

  test('no automatic claim creation/resolution or conflict state machine', () => {
    expect(
      findViolations([
        { label: 'claim mutation', regex: /\baddFileClaim\b|\breleaseFileClaim\b/ },
        { label: 'conflict resolution', regex: /resolveConflict|autoResolve|ConflictStateMachine/ },
      ]),
    ).toEqual([]);
  });

  test('no handoff, UI, or validation-runner behavior', () => {
    expect(
      findViolations([
        { label: 'handoff implementation', regex: /handoff[A-Z_]|createHandoff|HandoffRecord|requestHandoff|acceptHandoff/ },
        { label: 'UI import', regex: /\b(react|electron)\b|from\s+['"][^'"]*desktop/i },
        { label: 'validation runner', regex: /runValidation|validation_runner|ValidationRunner/ },
      ]),
    ).toEqual([]);
  });

  test('the live watcher records evidence ONLY through the Phase 4C event core (no direct file/git writes)', () => {
    const liveWatcher = read(path.join(repoRoot, 'src', 'core', 'coordination', 'live_watcher.ts'));
    // Evidence is appended only by recordFileChangeEvidence; the lifecycle file
    // itself performs no direct writes to source or evidence storage.
    expect(liveWatcher).toContain('recordFileChangeEvidence');
    expect(liveWatcher).not.toMatch(/writeFileSync|appendFileSync|mkdirSync|rmSync/);
    // It uses fs.watch only for read observation (this is the allowed Phase 4D addition).
    expect(liveWatcher).toMatch(/fs\.watch\s*\(/);
    expect(liveWatcher).not.toMatch(/spawnSync|execSync|exec\(/);
  });

  test('Phase 4D adds NO MCP live-watch control tool (registry unchanged at 32, no watch tool)', () => {
    const tools = buildVibecodeMcpTools();
    expect(tools).toHaveLength(32);
    expect(VIBECODE_MCP_TOOL_NAMES).toHaveLength(32);
    const evidenceTools = VIBECODE_MCP_TOOL_NAMES.filter((n) => n.includes('evidence')).sort();
    expect(evidenceTools).toEqual(['vibecode_evidence_list', 'vibecode_evidence_scan']);
    for (const name of VIBECODE_MCP_TOOL_NAMES) {
      expect(name).not.toMatch(/watch/i);
      expect(name).not.toMatch(/commit|guard/i);
    }
  });
});
