import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  registerAgent,
  listAgents,
  heartbeatAgent,
  getAgentStatus,
  markAgentTerminated,
} from '../../../src/core/coordination/agents.js';
import { CoordinationError } from '../../../src/core/coordination/errors.js';
import { HEARTBEAT_TTL_MS } from '../../../src/core/coordination/heartbeat.js';
import {
  getCoordinationPaths,
  loadCoordinationState,
  writeCoordinationState,
  createEmptyCoordinationState,
} from '../../../src/core/coordination/state.js';

/**
 * Phase 2 core: persistent agent sessions + heartbeat. Advisory only — the
 * only file ever written is .vibecode/coordination/state.json. claims stays an
 * empty array (Phase 2 does not implement claim behavior).
 */

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

describe('registerAgent', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-agents-register-');
  });
  afterEach(() => repo.cleanup());

  test('creates an active session and writes state.json under .vibecode/coordination/', () => {
    const session = registerAgent(
      repo.repoRoot,
      { agent_name: 'Codex A', agent_type: 'codex', terminal_session_id: 'term-1', pid: 4242 },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-fixed-1' },
    );

    expect(session).toMatchObject({
      agent_id: 'agent-fixed-1',
      agent_name: 'Codex A',
      agent_type: 'codex',
      terminal_session_id: 'term-1',
      pid: 4242,
      status: 'active',
      started_at: '2026-06-06T00:00:00.000Z',
      last_heartbeat_at: '2026-06-06T00:00:00.000Z',
      claims: [],
      metadata: {},
    });

    const stateFile = getCoordinationPaths(repo.repoRoot).stateFile;
    expect(fs.existsSync(stateFile)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { agents: unknown[]; last_updated: string };
    expect(onDisk.agents).toHaveLength(1);
    expect(onDisk.last_updated).toBe('2026-06-06T00:00:00.000Z');

    // The only file written is the single coordination state file.
    expect(listFiles(repo.repoRoot)).toEqual(['.vibecode/coordination/state.json']);
    // Advisory model: never any lock files.
    expect(listFiles(repo.repoRoot).some((p) => p.endsWith('.lock'))).toBe(false);
  });

  test('registering two agents creates two unique agent ids', () => {
    const a = registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });
    const b = registerAgent(repo.repoRoot, { agent_name: 'B', agent_type: 'claude' });
    expect(a.agent_id).not.toBe(b.agent_id);
    expect(listAgents(repo.repoRoot)).toHaveLength(2);
  });

  test('duplicate agent names are allowed (ids remain unique)', () => {
    const a = registerAgent(repo.repoRoot, { agent_name: 'Twin', agent_type: 'codex' });
    const b = registerAgent(repo.repoRoot, { agent_name: 'Twin', agent_type: 'codex' });
    expect(a.agent_name).toBe('Twin');
    expect(b.agent_name).toBe('Twin');
    expect(a.agent_id).not.toBe(b.agent_id);
  });

  test('rejects an invalid agent_type with a structured CoordinationError', () => {
    expect(() =>
      registerAgent(repo.repoRoot, { agent_name: 'X', agent_type: 'gpt' as never }),
    ).toThrowError(CoordinationError);
    try {
      registerAgent(repo.repoRoot, { agent_name: 'X', agent_type: 'gpt' as never });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('INVALID_AGENT_TYPE');
    }
    // A rejected registration must not write any state.
    expect(fs.existsSync(getCoordinationPaths(repo.repoRoot).stateFile)).toBe(false);
  });

  test('rejects an empty agent_name', () => {
    try {
      registerAgent(repo.repoRoot, { agent_name: '  ', agent_type: 'codex' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('INVALID_AGENT_NAME');
    }
  });

  test('preserves existing claims/conflicts/handoffs arrays untouched', () => {
    // Seed a state that already carries (advisory) entries in the other arrays.
    const seeded = {
      ...createEmptyCoordinationState(repo.repoRoot, '2026-06-06T00:00:00.000Z'),
      claims: [{ id: 'claim-1' }],
      conflicts: [{ id: 'conflict-1' }],
      handoffs: [{ id: 'handoff-1' }],
    } as never;
    writeCoordinationState(repo.repoRoot, seeded);

    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' }, { now: '2026-06-06T01:00:00.000Z' });

    const onDisk = JSON.parse(fs.readFileSync(getCoordinationPaths(repo.repoRoot).stateFile, 'utf8'));
    expect(onDisk.claims).toEqual([{ id: 'claim-1' }]);
    expect(onDisk.conflicts).toEqual([{ id: 'conflict-1' }]);
    expect(onDisk.handoffs).toEqual([{ id: 'handoff-1' }]);
    expect(onDisk.agents).toHaveLength(1);
    expect(onDisk.last_updated).toBe('2026-06-06T01:00:00.000Z');
  });

  test('does not modify a representative source file', () => {
    fs.mkdirSync(path.join(repo.repoRoot, 'src'), { recursive: true });
    const sourcePath = path.join(repo.repoRoot, 'src', 'example.ts');
    fs.writeFileSync(sourcePath, 'export const x = 1;\n', 'utf8');

    registerAgent(repo.repoRoot, { agent_name: 'A', agent_type: 'codex' });

    expect(fs.readFileSync(sourcePath, 'utf8')).toBe('export const x = 1;\n');
    // No config.json is ever created under coordination.
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'config.json'))).toBe(false);
  });
});

describe('listAgents', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-agents-list-');
  });
  afterEach(() => repo.cleanup());

  test('returns an empty list and writes nothing when no state file exists', () => {
    const before = listFiles(repo.repoRoot);
    expect(listAgents(repo.repoRoot)).toEqual([]);
    // Read-only: must not initialize state.
    expect(fs.existsSync(getCoordinationPaths(repo.repoRoot).stateFile)).toBe(false);
    expect(listFiles(repo.repoRoot)).toEqual(before);
  });

  test('marks an agent stale once its heartbeat is older than the TTL (computed-only)', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );

    const nowFresh = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS - 1).toISOString();
    expect(listAgents(repo.repoRoot, { now: nowFresh })[0].status).toBe('active');

    const nowStale = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 1000).toISOString();
    const stale = listAgents(repo.repoRoot, { now: nowStale });
    expect(stale[0].status).toBe('stale');

    // Computed-only: the persisted status must remain 'active', not 'stale'.
    const persisted = loadCoordinationState(repo.repoRoot).agents[0];
    expect(persisted.status).toBe('active');
  });
});

describe('heartbeatAgent', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-agents-hb-');
  });
  afterEach(() => repo.cleanup());

  test('updates last_heartbeat_at and revives a stale agent to active', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );

    // Far in the future: a read would compute this agent as stale.
    const later = new Date(Date.parse('2026-06-06T00:00:00.000Z') + HEARTBEAT_TTL_MS + 10_000).toISOString();
    expect(listAgents(repo.repoRoot, { now: later })[0].status).toBe('stale');

    const beat = heartbeatAgent(repo.repoRoot, 'agent-1', { now: later });
    expect(beat.last_heartbeat_at).toBe(later);
    expect(beat.status).toBe('active');

    // After heartbeat, a read at the same instant is active again.
    expect(listAgents(repo.repoRoot, { now: later })[0].status).toBe('active');
  });

  test('throws AGENT_NOT_FOUND for an unknown agent and does not create it', () => {
    try {
      heartbeatAgent(repo.repoRoot, 'missing-agent');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CoordinationError);
      expect((err as CoordinationError).code).toBe('AGENT_NOT_FOUND');
    }
    // No implicit registration: state stays empty.
    expect(listAgents(repo.repoRoot)).toEqual([]);
  });
});

describe('getAgentStatus', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-agents-status-');
  });
  afterEach(() => repo.cleanup());

  test('returns one agent with its computed status', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    const got = getAgentStatus(repo.repoRoot, 'agent-1', { now: '2026-06-06T00:00:30.000Z' });
    expect(got.agent_id).toBe('agent-1');
    expect(got.status).toBe('active');
  });

  test('throws AGENT_NOT_FOUND for an unknown agent', () => {
    try {
      getAgentStatus(repo.repoRoot, 'nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CoordinationError).code).toBe('AGENT_NOT_FOUND');
    }
  });
});

describe('markAgentTerminated', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    repo = makeRepo('vibecode-agents-term-');
  });
  afterEach(() => repo.cleanup());

  test('persists terminated status', () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'A', agent_type: 'codex' },
      { now: '2026-06-06T00:00:00.000Z', agentId: 'agent-1' },
    );
    const terminated = markAgentTerminated(repo.repoRoot, 'agent-1', { now: '2026-06-06T00:05:00.000Z' });
    expect(terminated.status).toBe('terminated');
    expect(loadCoordinationState(repo.repoRoot).agents[0].status).toBe('terminated');
  });
});
