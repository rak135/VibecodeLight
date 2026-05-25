import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import type { CodeGraphToolEntry } from '../../../src/core/scanning/external_tools.js';
import {
  CODEGRAPH_USAGE_NOTE,
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

  // F. no behavior expansion: status is informational, never claims CodeGraph is in use.
  test('ready status stays detect-only and informational (no usage/enrichment claim)', () => {
    const status = summarizeCodeGraphStatus(entry({ available: true, initialized: true }));
    expect(status.mode).toBe('detect-only');
    expect(status.usageNote).toBe(CODEGRAPH_USAGE_NOTE);
    // The note must make clear context usage is NOT enabled yet.
    expect(status.usageNote.toLowerCase()).toContain('not implemented');
    // No field implies CodeGraph is actively enabled/used for context.
    expect(Object.keys(status)).not.toContain('enabled');
    expect(Object.keys(status)).not.toContain('using');
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
