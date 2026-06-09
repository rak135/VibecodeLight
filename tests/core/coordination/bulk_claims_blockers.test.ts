import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim, listFileClaims } from '../../../src/core/coordination/claims.js';
import { planClaims } from '../../../src/core/coordination/claim_planning.js';
import { addBulkClaims, listClaimIntents } from '../../../src/core/coordination/bulk_claims.js';
import { getFinalizeCheck } from '../../../src/core/coordination/finalize_check.js';
import { CoordinationError } from '../../../src/core/coordination/errors.js';
import { loadCoordinationState } from '../../../src/core/coordination/state.js';

function git(args: string[], cwd: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@example.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  git(['config', 'core.autocrlf', 'false'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
  git(['add', '.gitignore'], repoRoot);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repoRoot);
  return { repoRoot, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function write(repoRoot: string, rel: string, content = 'x\n'): void {
  const p = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function mkdir(repoRoot: string, rel: string): void {
  fs.mkdirSync(path.join(repoRoot, rel), { recursive: true });
}

function build(repoRoot: string, agentId: string): void {
  registerAgent(
    repoRoot,
    { agent_name: agentId, agent_type: 'codex', metadata: { operating_mode: 'build', task: 'work' } },
    { agentId },
  );
}

describe('Phase 2A blocker fix 1 — directory claims are rejected', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-dir-')));
  afterEach(() => repo.cleanup());

  test('plan classifies an existing directory as directory_not_supported (blocking)', () => {
    build(repo.repoRoot, 'agent-a');
    mkdir(repo.repoRoot, 'src');
    write(repo.repoRoot, 'src/a.ts');

    const plan = planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['src'] });
    expect(plan.paths[0].status).toBe('directory_not_supported');
    expect(plan.paths[0].blocking ?? true).toBe(true);
    expect(plan.can_claim_all).toBe(false);
    expect(plan.blocked_paths).toEqual(['src']);
  });

  test('add-bulk with only a directory creates zero claims and zero intents', () => {
    build(repo.repoRoot, 'agent-a');
    mkdir(repo.repoRoot, 'src');
    write(repo.repoRoot, 'src/a.ts');

    const result = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'x', paths: ['src'] });
    expect(result.status).toBe('blocked');
    expect(result.created_claims).toEqual([]);
    expect(result.blocked_paths.map((b) => b.path)).toEqual(['src']);
    expect(result.blocked_paths[0].reason).toBe('directory_not_supported');
    // No conflict for a local validation block.
    expect(result.conflict_id).toBeNull();
    expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
    expect(listClaimIntents(repo.repoRoot)).toHaveLength(0);
  });

  test('add-bulk with directory + file creates zero claims and zero intents (atomic)', () => {
    build(repo.repoRoot, 'agent-a');
    mkdir(repo.repoRoot, 'src');

    const result = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'x', paths: ['src', 'src/new.ts'] });
    expect(result.status).toBe('blocked');
    expect(result.created_claims).toEqual([]);
    expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
    expect(listClaimIntents(repo.repoRoot)).toHaveLength(0);
  });

  test('single-file addFileClaim rejects an existing directory', () => {
    build(repo.repoRoot, 'agent-a');
    mkdir(repo.repoRoot, 'src');
    try {
      addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src', mode: 'exclusive' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('DIRECTORY_CLAIM_NOT_ALLOWED');
    }
    expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
  });

  test('regression: a directory cannot be claimed to authorize a descendant file in finalize', () => {
    build(repo.repoRoot, 'agent-a');
    mkdir(repo.repoRoot, 'src');

    // Attempt (and fail) to bulk-claim the whole src directory.
    const blocked = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'x', paths: ['src'] });
    expect(blocked.status).toBe('blocked');

    // A descendant file is now dirty but unclaimed → finalize blocks it.
    write(repo.repoRoot, 'src/a.ts', 'export const a = 1;\n');
    const finalize = getFinalizeCheck({ repoRoot: repo.repoRoot, agent_id: 'agent-a' });
    expect(finalize.status).toBe('blocked');
    expect(finalize.summary.allowed_count).toBe(0);
    expect(finalize.blocks.some((b) => b.path === 'src/a.ts')).toBe(true);
  });
});

describe('Phase 2A blocker fix 2 — valid build session (non-empty task) required', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-task-')));
  afterEach(() => repo.cleanup());

  function buildNoTask(agentId: string): void {
    registerAgent(
      repo.repoRoot,
      { agent_name: agentId, agent_type: 'codex', metadata: { operating_mode: 'build' } },
      { agentId },
    );
  }

  test('plan with a build/no-task agent is blocked as an invalid session', () => {
    buildNoTask('agent-nt');
    try {
      planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-nt', paths: ['src/a.ts'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('INVALID_AGENT_SESSION');
    }
  });

  test('add-bulk with a build/no-task agent creates zero claims/intents', () => {
    buildNoTask('agent-nt');
    try {
      addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-nt', intent: 'x', paths: ['src/a.ts'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CoordinationError).code).toBe('INVALID_AGENT_SESSION');
    }
    // Only the registration write exists; no claims/intents were created.
    const state = loadCoordinationState(repo.repoRoot);
    expect(state.claims).toHaveLength(0);
    expect(state.intents).toHaveLength(0);
  });

  test('single-file claim with a build/no-task agent is denied', () => {
    buildNoTask('agent-nt');
    const result = addFileClaim(repo.repoRoot, { agent_id: 'agent-nt', path: 'src/a.ts', mode: 'exclusive' });
    expect(result.denied).toBe(true);
    expect(result.claim).toBeNull();
    expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
  });

  test('empty/whitespace task is also rejected', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'ws', agent_type: 'codex', metadata: { operating_mode: 'build', task: '   ' } },
      { agentId: 'agent-ws' },
    );
    expect(() => planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-ws', paths: ['src/a.ts'] }))
      .toThrowError(/INVALID_AGENT_SESSION|task/i);
  });

  test('a valid build agent with a task still works', () => {
    build(repo.repoRoot, 'agent-ok');
    const result = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-ok', intent: 'x', paths: ['src/a.ts'] });
    expect(result.status).toBe('ok');
    expect(result.created_claims).toHaveLength(1);
  });
});

describe('Phase 2A blocker fix — additional regression coverage', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => (repo = makeRepo('vibecode-reg-')));
  afterEach(() => repo.cleanup());

  test('.git internals and absolute outside-repo paths are invalid in plan', () => {
    build(repo.repoRoot, 'agent-a');
    const abs = process.platform === 'win32' ? 'C:\\Windows\\system32\\drivers\\etc\\hosts' : '/etc/hosts';
    const plan = planClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['.git/config', abs] });
    expect(plan.paths.every((p) => p.status === 'invalid')).toBe(true);
    expect(plan.can_claim_all).toBe(false);
  });

  test('a generated/ignored path in a mixed set blocks the whole bulk atomically', () => {
    build(repo.repoRoot, 'agent-a');
    const result = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'x', paths: ['node_modules/pkg/index.js', 'src/a.ts'] });
    expect(result.status).toBe('blocked');
    expect(result.created_claims).toEqual([]);
    expect(listFileClaims(repo.repoRoot)).toHaveLength(0);
    expect(listClaimIntents(repo.repoRoot)).toHaveLength(0);
  });

  test('bulk add with only already-owned paths is ok and creates no new claims', () => {
    build(repo.repoRoot, 'agent-a');
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/a.ts', mode: 'exclusive' });
    const result = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'x', paths: ['src/a.ts'] });
    expect(result.status).toBe('ok');
    expect(result.created_claims).toEqual([]);
    expect(result.already_owned_paths).toEqual(['src/a.ts']);
    expect(listFileClaims(repo.repoRoot)).toHaveLength(1);
  });

  test('extension with already-owned + new path only creates the new claim', () => {
    build(repo.repoRoot, 'agent-a');
    const first = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'x', paths: ['src/a.ts'] });
    const extended = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent_id: first.intent_id ?? undefined,
      paths: ['src/a.ts', 'src/b.ts'],
    });
    expect(extended.status).toBe('ok');
    expect(extended.already_owned_paths).toEqual(['src/a.ts']);
    expect(extended.created_claims.map((c) => c.path)).toEqual(['src/b.ts']);
    expect(listFileClaims(repo.repoRoot)).toHaveLength(2);
  });

  test('passing both intent and intent_id uses intent_id (extension wins)', () => {
    build(repo.repoRoot, 'agent-a');
    const first = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'original', paths: ['src/a.ts'] });
    const both = addBulkClaims({
      repoRoot: repo.repoRoot,
      agent_id: 'agent-a',
      intent: 'IGNORED new text',
      intent_id: first.intent_id ?? undefined,
      paths: ['src/b.ts'],
    });
    expect(both.intent_id).toBe(first.intent_id);
    expect(both.intent).toBe('original'); // intent text comes from the existing intent
    expect(listClaimIntents(repo.repoRoot)).toHaveLength(1);
  });

  test('old coordination state without intents normalizes to []', () => {
    build(repo.repoRoot, 'agent-a');
    // Simulate a pre-Phase-2A state file with no `intents` key.
    const stateFile = path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete raw.intents;
    fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2), 'utf8');

    expect(loadCoordinationState(repo.repoRoot).intents).toEqual([]);
    // A bulk claim against the legacy state still works.
    const result = addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', intent: 'x', paths: ['src/a.ts'] });
    expect(result.status).toBe('ok');
  });
});
