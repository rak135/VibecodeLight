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

interface SuccessEnvelope {
  ok: true;
  data: Record<string, unknown>;
  artifacts: unknown[];
  warnings: unknown[];
}

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; path: string; details: string[] };
}

describe('vibecode claims (CLI)', () => {
  let repo: { repoRoot: string; cleanup: () => void };

  beforeEach(() => {
    repo = makeRepo('vibecode-claims-cli-');
  });

  afterEach(() => repo.cleanup());

  async function registerAgent(name = 'Codex A'): Promise<string> {
    const res = await runCli([
      'agents', 'register', '--repo', repo.repoRoot, '--name', name, '--type', 'codex', '--json',
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    return (env.data.agent as { agent_id: string }).agent_id;
  }

  async function addClaim(agentId: string, claimPath = 'src/app.ts', mode = 'exclusive'): Promise<SuccessEnvelope> {
    const res = await runCli([
      'claims', 'add', '--repo', repo.repoRoot, '--agent', agentId, '--path', claimPath, '--mode', mode, '--json',
    ]);
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.logs[0]) as SuccessEnvelope;
  }

  test('claim add --json returns a stable envelope and persists state', async () => {
    const agentId = await registerAgent();

    const env = await addClaim(agentId);

    expect(env.ok).toBe(true);
    expect(env.artifacts).toEqual([]);
    expect(env.warnings).toEqual([]);
    const claim = env.data.claim as Record<string, unknown>;
    expect(claim.agent_id).toBe(agentId);
    expect(claim.path).toBe('src/app.ts');
    expect(claim.mode).toBe('exclusive');
    expect(claim.status).toBe('active');
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(true);
  });

  test('claims list --json returns claims and --agent filters them', async () => {
    const a = await registerAgent('A');
    const b = await registerAgent('B');
    await addClaim(a, 'src/a.ts');
    await addClaim(b, 'src/b.ts');

    const all = await runCli(['claims', 'list', '--repo', repo.repoRoot, '--json']);
    expect(all.exitCode).toBe(0);
    expect(((JSON.parse(all.logs[0]) as SuccessEnvelope).data.claims as unknown[])).toHaveLength(2);

    const filtered = await runCli(['claims', 'list', '--repo', repo.repoRoot, '--agent', a, '--json']);
    expect(filtered.exitCode).toBe(0);
    const claims = (JSON.parse(filtered.logs[0]) as SuccessEnvelope).data.claims as Array<{ agent_id: string; path: string }>;
    expect(claims).toEqual([expect.objectContaining({ agent_id: a, path: 'src/a.ts' })]);
  });

  test('claims status --path returns matching claims and availability', async () => {
    const agentId = await registerAgent();
    await addClaim(agentId, 'src', 'shared');

    const res = await runCli(['claims', 'status', '--repo', repo.repoRoot, '--path', 'src/app.ts', '--json']);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    const status = env.data.status as { path: string; matching_claims: unknown[]; can_claim_shared: boolean; can_claim_exclusive: boolean };
    expect(status.path).toBe('src/app.ts');
    expect(status.matching_claims).toHaveLength(1);
    expect(status.can_claim_shared).toBe(true);
    expect(status.can_claim_exclusive).toBe(false);
  });

  test('claims release --claim releases the claim', async () => {
    const agentId = await registerAgent();
    const added = await addClaim(agentId, 'src/app.ts');
    const claimId = (added.data.claim as { claim_id: string }).claim_id;

    const res = await runCli(['claims', 'release', '--repo', repo.repoRoot, '--claim', claimId, '--json']);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.logs[0]) as SuccessEnvelope;
    expect((env.data.claim as { status: string }).status).toBe('released');
  });

  test('claim denied returns a structured CLAIM_DENIED error', async () => {
    const a = await registerAgent('A');
    const b = await registerAgent('B');
    await addClaim(a, 'src/app.ts', 'exclusive');

    const res = await runCli([
      'claims', 'add', '--repo', repo.repoRoot, '--agent', b, '--path', 'src', '--mode', 'exclusive', '--json',
    ]);

    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.logs[0]) as ErrorEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('CLAIM_DENIED');
    expect(env.error.details.join('\n')).toContain('claim');
  });

  test('invalid path and missing agent return structured errors', async () => {
    const agentId = await registerAgent();
    const invalidPath = await runCli([
      'claims', 'add', '--repo', repo.repoRoot, '--agent', agentId, '--path', '..\\outside.ts', '--mode', 'exclusive', '--json',
    ]);
    expect(invalidPath.exitCode).toBe(1);
    expect((JSON.parse(invalidPath.logs[0]) as ErrorEnvelope).error.code).toBe('INVALID_CLAIM_PATH');

    const missingAgent = await runCli([
      'claims', 'add', '--repo', repo.repoRoot, '--agent', 'missing-agent', '--path', 'src/app.ts', '--mode', 'exclusive', '--json',
    ]);
    expect(missingAgent.exitCode).toBe(1);
    expect((JSON.parse(missingAgent.logs[0]) as ErrorEnvelope).error.code).toBe('AGENT_NOT_FOUND');
  });
});
