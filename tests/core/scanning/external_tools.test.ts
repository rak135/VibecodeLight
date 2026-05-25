import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import type { CodeGraphDetection } from '../../../src/adapters/codegraph/codegraph_types.js';
import {
  buildExternalToolsArtifact,
  writeExternalToolsArtifact,
} from '../../../src/core/scanning/external_tools.js';

function tempScanDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-external-tools-'));
}

describe('external_tools artifact', () => {
  test('unavailable + uninitialized produces a stable detect-only shape with warnings', () => {
    const detection: CodeGraphDetection = {
      available: false,
      initialized: false,
      warnings: ['CODEGRAPH_NOT_FOUND: codegraph command was not found'],
    };
    const artifact = buildExternalToolsArtifact(detection);
    expect(artifact).toEqual({
      tools: {
        codegraph: {
          available: false,
          initialized: false,
          mode: 'detect-only',
          warnings: ['CODEGRAPH_NOT_FOUND: codegraph command was not found'],
        },
      },
    });
  });

  test('available + initialized records codegraph_dir and stays detect-only', () => {
    const detection: CodeGraphDetection = {
      available: true,
      initialized: true,
      command: 'codegraph',
      version: '1.0.0',
      codegraphDir: '.codegraph',
      warnings: [],
    };
    const artifact = buildExternalToolsArtifact(detection);
    expect(artifact.tools.codegraph.available).toBe(true);
    expect(artifact.tools.codegraph.initialized).toBe(true);
    expect(artifact.tools.codegraph.mode).toBe('detect-only');
    expect(artifact.tools.codegraph.codegraph_dir).toBe('.codegraph');
    expect(artifact.tools.codegraph.warnings).toEqual([]);
  });

  test('artifact records detection only - no graph dump, source snippets, or context output', () => {
    const detection: CodeGraphDetection = {
      available: true,
      initialized: true,
      command: 'codegraph',
      version: '1.0.0',
      codegraphDir: '.codegraph',
      warnings: [],
    };
    const artifact = buildExternalToolsArtifact(detection);
    const serialized = JSON.stringify(artifact);
    const allowedKeys = ['available', 'initialized', 'mode', 'warnings', 'codegraph_dir'];
    const codegraphKeys = Object.keys(artifact.tools.codegraph);
    for (const key of codegraphKeys) {
      expect(allowedKeys).toContain(key);
    }
    // Detection-only: no graph dump / context output / source snippet leakage.
    expect(serialized).not.toContain('items');
    expect(serialized).not.toContain('symbols');
    expect(serialized).not.toContain('snippet');
    expect(serialized).not.toContain('nodes');
    expect(serialized).not.toContain('edges');
    expect(serialized).not.toContain('context_pack');
  });

  test('writeExternalToolsArtifact writes external_tools.json and returns its path', () => {
    const scanDir = tempScanDir();
    try {
      const detection: CodeGraphDetection = {
        available: false,
        initialized: false,
        warnings: [],
      };
      const outPath = writeExternalToolsArtifact(scanDir, detection);
      expect(outPath).toBe(path.join(scanDir, 'external_tools.json'));
      expect(fs.existsSync(outPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      expect(parsed.tools.codegraph.mode).toBe('detect-only');
    } finally {
      fs.rmSync(scanDir, { recursive: true, force: true });
    }
  });
});
