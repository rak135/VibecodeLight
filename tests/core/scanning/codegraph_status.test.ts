import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import type { CodeGraphToolEntry } from '../../../src/core/scanning/external_tools.js';
import {
  CODEGRAPH_USAGE_NOTE,
  formatCodeGraphWarning,
  readRunCodeGraphStatus,
  summarizeCodeGraphStatus,
} from '../../../src/core/scanning/codegraph_status.js';

function entry(overrides: Partial<CodeGraphToolEntry>): CodeGraphToolEntry {
  return {
    available: false,
    initialized: false,
    mode: 'detect-only',
    warnings: [],
    ...overrides,
  };
}

function tempRun(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-status-'));
}

function writeExternalTools(runDir: string, codegraph: unknown): void {
  const scanDir = path.join(runDir, 'scan');
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(
    path.join(scanDir, 'external_tools.json'),
    `${JSON.stringify({ tools: { codegraph } }, null, 2)}\n`,
    'utf8',
  );
}

describe('summarizeCodeGraphStatus', () => {
  // A. unavailable + uninitialized => optional "not installed" status, never an error.
  test('available=false reports not-installed as a neutral optional status', () => {
    const status = summarizeCodeGraphStatus(
      entry({ available: false, initialized: false, warnings: ['CODEGRAPH_NOT_FOUND: ...'] }),
    );
    expect(status.state).toBe('not-installed');
    expect(status.label).toBe('CodeGraph: not installed (optional)');
    expect(status.label.toLowerCase()).toContain('optional');
    // Neutral phrasing: never surfaced as an error/failure.
    expect(status.label.toLowerCase()).not.toContain('error');
    expect(status.label.toLowerCase()).not.toContain('failed');
    expect(status.mode).toBe('detect-only');
  });

  // B. ready state.
  test('available=true + initialized=true reports ready', () => {
    const status = summarizeCodeGraphStatus(entry({ available: true, initialized: true }));
    expect(status.state).toBe('ready');
    expect(status.label).toBe('CodeGraph: ready');
    expect(status.mode).toBe('detect-only');
  });

  // C. installed but not initialized.
  test('available=true + initialized=false reports installed, not initialized', () => {
    const status = summarizeCodeGraphStatus(entry({ available: true, initialized: false }));
    expect(status.state).toBe('installed-not-initialized');
    expect(status.label).toBe('CodeGraph: installed, not initialized');
    expect(status.mode).toBe('detect-only');
  });

  // D. missing entry => unknown / not scanned yet, no crash.
  test('missing entry reports unknown without throwing', () => {
    const status = summarizeCodeGraphStatus(undefined);
    expect(status.state).toBe('unknown');
    expect(status.label.toLowerCase()).toContain('scan');
    expect(status.mode).toBeNull();
  });

  // F. default remains detect-only: no automatic context use claim.
  test('ready status defaults to detect-only and records used=false', () => {
    const status = summarizeCodeGraphStatus(entry({ available: true, initialized: true }));
    expect(status.mode).toBe('detect-only');
    expect(status.usedForContext).toBe(false);
    expect(status.usageReason).toBe('detect-only');
    expect(status.usageNote).toBe(CODEGRAPH_USAGE_NOTE);
    expect(status.usageNote.toLowerCase()).toContain('detect-only');
    expect(Object.keys(status)).not.toContain('enabled');
  });
});

describe('readRunCodeGraphStatus', () => {
  // D. missing artifact => unknown, no crash.
  test('returns unknown when external_tools.json is absent', () => {
    const runDir = tempRun();
    try {
      const status = readRunCodeGraphStatus(runDir);
      expect(status.state).toBe('unknown');
      expect(status.mode).toBeNull();
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('reads ready state from a real scan/external_tools.json artifact', () => {
    const runDir = tempRun();
    try {
      writeExternalTools(runDir, {
        available: true,
        initialized: true,
        mode: 'detect-only',
        warnings: [],
        codegraph_dir: '.codegraph',
      });
      const status = readRunCodeGraphStatus(runDir);
      expect(status.state).toBe('ready');
      expect(status.label).toBe('CodeGraph: ready');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('reads use-existing usage from codegraph_usage.json', () => {
    const runDir = tempRun();
    try {
      writeExternalTools(runDir, {
        available: true,
        initialized: true,
        mode: 'use-existing',
        used_for_context: true,
        context_artifact: 'scan/codegraph_context.md',
        warnings: [],
        codegraph_dir: '.codegraph',
      });
      fs.writeFileSync(
        path.join(runDir, 'scan', 'codegraph_usage.json'),
        JSON.stringify({
          mode: 'use-existing',
          used: true,
          reason: 'EXISTING_INDEX',
          artifact: 'scan/codegraph_context.md',
          codegraph_repo_atlas_generated: true,
          codegraph_repo_atlas_reason: 'generated',
          codegraph_repo_atlas_artifact: 'scan/codegraph_repo_atlas.md',
          codegraph_repo_atlas_json_artifact: 'scan/codegraph_repo_atlas.json',
          repo_atlas_generated: true,
          repo_atlas_reason: 'generated',
          repo_atlas_artifact: 'scan/repo_atlas.md',
          repo_atlas_json_artifact: 'scan/repo_atlas.json',
          warnings: [],
        }, null, 2),
        'utf8',
      );
      const status = readRunCodeGraphStatus(runDir);
      expect(status.state).toBe('ready');
      expect(status.mode).toBe('use-existing');
      expect(status.usedForContext).toBe(true);
      expect(status.usageReason).toBe('existing index');
      expect(status.contextArtifact).toBe('scan/codegraph_context.md');
      expect(status.repoAtlasGenerated).toBe(true);
      expect(status.repoAtlasReason).toBe('generated');
      expect(status.repoAtlasArtifact).toBe('scan/codegraph_repo_atlas.md');
      expect(status.repoAtlasJsonArtifact).toBe('scan/codegraph_repo_atlas.json');
      expect(status.repoAtlasNote).toBe('CodeGraph-derived Repo Atlas: generated.');
      expect(status.usageNote).toBe('CodeGraph used: yes — existing index.');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('reads skipped use-existing usage reason from codegraph_usage.json', () => {
    const runDir = tempRun();
    try {
      writeExternalTools(runDir, {
        available: true,
        initialized: true,
        mode: 'use-existing',
        used_for_context: false,
        warnings: [],
        codegraph_dir: '.codegraph',
      });
      fs.writeFileSync(
        path.join(runDir, 'scan', 'codegraph_usage.json'),
        JSON.stringify({ mode: 'use-existing', used: false, reason: 'CODEGRAPH_INDEX_STALE', repo_atlas_generated: false, repo_atlas_reason: 'CODEGRAPH_INDEX_STALE', warnings: [] }, null, 2),
        'utf8',
      );
      const status = readRunCodeGraphStatus(runDir);
      expect(status.mode).toBe('use-existing');
      expect(status.usedForContext).toBe(false);
      expect(status.usageReason).toBe('skipped: CODEGRAPH_INDEX_STALE');
      expect(status.usageNote).toBe('CodeGraph used: no — skipped: CODEGRAPH_INDEX_STALE.');
      expect(status.repoAtlasGenerated).toBe(false);
      expect(status.repoAtlasReason).toBe('not generated — CODEGRAPH_INDEX_STALE');
      expect(status.repoAtlasNote).toBe('CodeGraph-derived Repo Atlas: not generated — CODEGRAPH_INDEX_STALE.');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('returns unknown for a corrupt artifact without throwing', () => {
    const runDir = tempRun();
    try {
      const scanDir = path.join(runDir, 'scan');
      fs.mkdirSync(scanDir, { recursive: true });
      fs.writeFileSync(path.join(scanDir, 'external_tools.json'), '{ not json', 'utf8');
      const status = readRunCodeGraphStatus(runDir);
      expect(status.state).toBe('unknown');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe('formatCodeGraphWarning', () => {
  // Stale-index warning gets neutral, action-oriented wording — never red/fatal.
  test('CODEGRAPH_INDEX_STALE maps to neutral text suggesting Sync', () => {
    const text = formatCodeGraphWarning(
      'CODEGRAPH_INDEX_STALE: pending changes reported by codegraph status --json; using existing index without automatic sync',
    );
    expect(text).toBe('Index may be stale. Existing index was used. Run Sync to update it.');
    // Neutral language: no error/failed framing.
    expect(text.toLowerCase()).not.toContain('error');
    expect(text.toLowerCase()).not.toContain('failed');
    expect(text.toLowerCase()).not.toContain('fatal');
  });

  test('known codes produce stable neutral text', () => {
    expect(formatCodeGraphWarning('CODEGRAPH_OUTPUT_TRUNCATED: 32768 bytes')).toContain('truncated');
    expect(formatCodeGraphWarning('CODEGRAPH_STATUS_FAILED: boom')).toContain('status check failed');
    expect(formatCodeGraphWarning('CODEGRAPH_CONTEXT_FAILED: boom')).toContain('context command failed');
    expect(formatCodeGraphWarning('CODEGRAPH_NOT_INSTALLED')).toContain('not installed');
    expect(formatCodeGraphWarning('CODEGRAPH_NOT_INITIALIZED')).toContain('not initialized');
  });

  test('unknown code falls back to the message portion or raw text', () => {
    expect(formatCodeGraphWarning('SOME_NEW_CODE: details here')).toBe('details here');
    expect(formatCodeGraphWarning('a bare string')).toBe('a bare string');
  });

  test('empty input returns empty', () => {
    expect(formatCodeGraphWarning('')).toBe('');
    expect(formatCodeGraphWarning('   ')).toBe('');
  });
});

describe('CodeGraphStatus.displayWarnings', () => {
  test('detect-only ready status has empty displayWarnings', () => {
    const status = summarizeCodeGraphStatus(entry({ available: true, initialized: true, warnings: [] }));
    expect(status.displayWarnings).toEqual([]);
  });

  test('readRunCodeGraphStatus surfaces formatted warnings from codegraph_usage.json', () => {
    const runDir = tempRun();
    try {
      writeExternalTools(runDir, {
        available: true,
        initialized: true,
        mode: 'use-existing',
        used_for_context: true,
        context_artifact: 'scan/codegraph_context.md',
        warnings: [],
        codegraph_dir: '.codegraph',
      });
      fs.writeFileSync(
        path.join(runDir, 'scan', 'codegraph_usage.json'),
        JSON.stringify({
          mode: 'use-existing',
          used: true,
          reason: 'EXISTING_INDEX',
          artifact: 'scan/codegraph_context.md',
          warnings: [
            'CODEGRAPH_INDEX_STALE: pending changes reported by codegraph status --json; using existing index without automatic sync',
          ],
        }, null, 2),
        'utf8',
      );
      const status = readRunCodeGraphStatus(runDir);
      // Use-existing succeeded; warning is informational, not a failure.
      expect(status.usedForContext).toBe(true);
      expect(status.usageNote).toBe('CodeGraph used: yes — existing index.');
      // Raw and display warnings are both present; renderer can use either.
      expect(status.warnings.some((w) => w.startsWith('CODEGRAPH_INDEX_STALE'))).toBe(true);
      expect(status.displayWarnings).toEqual([
        'Index may be stale. Existing index was used. Run Sync to update it.',
      ]);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('detect-only run never carries warnings even when external_tools listed some', () => {
    const runDir = tempRun();
    try {
      // detect-only scan with no usage file recorded.
      writeExternalTools(runDir, {
        available: true,
        initialized: true,
        mode: 'detect-only',
        warnings: [],
        codegraph_dir: '.codegraph',
      });
      const status = readRunCodeGraphStatus(runDir);
      expect(status.mode).toBe('detect-only');
      expect(status.displayWarnings).toEqual([]);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe('codegraph_status boundary (detect-only display)', () => {
  // F. the display path must never execute CodeGraph (no init/index/sync/watch).
  test('the status module does not import child_process or reference codegraph subcommands', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../src/core/scanning/codegraph_status.ts'),
      'utf8',
    );
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('spawn');
    expect(source).not.toMatch(/codegraph\s+(init|index|sync|watch)/);
  });
});
