import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';

async function runCli(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.exitCode = 0;
    await createCli().parseAsync(['node', 'vibecode', ...args]);
    return {
      logs: logSpy.mock.calls.map((call) => String(call[0])),
      errors: errorSpy.mock.calls.map((call) => String(call[0])),
      exitCode: Number(process.exitCode ?? 0),
    };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  }
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('vibecode coordination status --json', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-coord-cli-');
  });
  afterEach(() => repo.cleanup());

  test('emits a stable success envelope for an empty workspace without writing state', async () => {
    const result = await runCli(['coordination', 'status', '--repo', repo.repoRoot, '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.logs).toHaveLength(1);

    const envelope = JSON.parse(result.logs[0]) as {
      ok: boolean;
      data: {
        workspace_root: string;
        state_file: string;
        state_file_exists: boolean;
        version: number;
        summary: { agents: number; claims: number; conflicts: number; handoffs: number };
      };
      artifacts: unknown[];
      warnings: unknown[];
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.data.workspace_root).toBe(repo.repoRoot);
    expect(envelope.data.state_file_exists).toBe(false);
    expect(envelope.data.version).toBe(1);
    expect(envelope.data.summary).toEqual({ agents: 0, claims: 0, conflicts: 0, handoffs: 0, unresolved_conflicts: 0, stale_claims: 0 });
    expect(envelope.artifacts).toEqual([]);
    expect(envelope.warnings).toEqual([]);

    // Read-only: status command must not initialize state.
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(false);
  });
});
