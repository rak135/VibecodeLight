import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import {
  detectCodeGraph,
  type CodeGraphVersionProbe,
} from '../../../src/adapters/codegraph/codegraph_cli.js';

const mockedSpawnSync = vi.mocked(spawnSync);

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-'));
}

/** A probe that records the commands it was asked to run. */
function recordingProbe(result: ReturnType<CodeGraphVersionProbe>): {
  probe: CodeGraphVersionProbe;
  calls: string[];
} {
  const calls: string[] = [];
  const probe: CodeGraphVersionProbe = (command: string) => {
    calls.push(command);
    return result;
  };
  return { probe, calls };
}

describe('detectCodeGraph', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    mockedSpawnSync.mockReset();
  });

  test('reports available=false with a warning when the codegraph command is missing', async () => {
    const repoRoot = tempRepo();
    try {
      const { probe } = recordingProbe({ found: false, warning: 'codegraph not found on PATH' });
      const detection = await detectCodeGraph(repoRoot, { versionProbe: probe });
      expect(detection.available).toBe(false);
      expect(detection.warnings.length).toBeGreaterThanOrEqual(1);
      expect(detection.warnings.join('\n')).toContain('CODEGRAPH_NOT_FOUND');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports available=true and captures the version when the probe succeeds', async () => {
    const repoRoot = tempRepo();
    try {
      const { probe } = recordingProbe({ found: true, version: '1.2.3' });
      const detection = await detectCodeGraph(repoRoot, { versionProbe: probe });
      expect(detection.available).toBe(true);
      expect(detection.version).toBe('1.2.3');
      expect(detection.command).toBe('codegraph');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports initialized=true when .codegraph/ exists', async () => {
    const repoRoot = tempRepo();
    try {
      const codegraphDir = path.join(repoRoot, '.codegraph');
      fs.mkdirSync(codegraphDir);
      fs.writeFileSync(path.join(codegraphDir, 'codegraph.db'), 'binary');

      const { probe } = recordingProbe({ found: true, version: '1.2.3' });
      const detection = await detectCodeGraph(repoRoot, { versionProbe: probe });
      expect(detection.initialized).toBe(true);
      expect(detection.codegraphDir).toBe('.codegraph');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports initialized=false without error when .codegraph/ is absent', async () => {
    const repoRoot = tempRepo();
    try {
      const { probe } = recordingProbe({ found: false, warning: 'missing' });
      const detection = await detectCodeGraph(repoRoot, { versionProbe: probe });
      expect(detection.initialized).toBe(false);
      expect(detection.codegraphDir).toBeUndefined();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a probe failure becomes a warning, not a thrown error, and command stays available', async () => {
    const repoRoot = tempRepo();
    try {
      // Command exists but `--version` failed (status probe failure).
      const { probe } = recordingProbe({ found: true, warning: 'version probe exited non-zero' });
      const detection = await detectCodeGraph(repoRoot, { versionProbe: probe });
      expect(detection.available).toBe(true);
      expect(detection.version).toBeUndefined();
      expect(detection.warnings.join('\n')).toContain('CODEGRAPH_VERSION_UNAVAILABLE');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('detection is read-only: it never creates .codegraph/ and never runs init/index/sync/watch', async () => {
    const repoRoot = tempRepo();
    try {
      const { probe, calls } = recordingProbe({ found: true, version: '1.2.3' });
      await detectCodeGraph(repoRoot, { versionProbe: probe });

      // No .codegraph/ created when it was absent.
      expect(fs.existsSync(path.join(repoRoot, '.codegraph'))).toBe(false);

      // The probe is the only command path, and it only ever probes the version.
      expect(calls).toEqual(['codegraph']);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('default probe handles a missing command (ENOENT) without throwing', async () => {
    const repoRoot = tempRepo();
    try {
      mockedSpawnSync.mockReturnValue({
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: new Error('spawn codegraph ENOENT'),
        pid: 0,
        output: ['', '', ''],
      } as unknown as ReturnType<typeof spawnSync>);

      const detection = await detectCodeGraph(repoRoot);
      expect(detection.available).toBe(false);
      expect(detection.warnings.join('\n')).toContain('CODEGRAPH_NOT_FOUND');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('default probe captures a version string when codegraph --version succeeds', async () => {
    const repoRoot = tempRepo();
    try {
      mockedSpawnSync.mockReturnValue({
        status: 0,
        signal: null,
        stdout: 'codegraph 0.9.0\n',
        stderr: '',
        pid: 123,
        output: ['', 'codegraph 0.9.0\n', ''],
      } as unknown as ReturnType<typeof spawnSync>);

      const detection = await detectCodeGraph(repoRoot);
      expect(detection.available).toBe(true);
      expect(detection.version).toContain('0.9.0');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
