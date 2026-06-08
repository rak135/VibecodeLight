import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';

/**
 * Phase 5A desktop coordination IPC bridge (read-only observability).
 *
 * Protected invariant: the renderer can read a compact coordination overview
 * through a single read-only channel. The bridge exposes NO mutation channels
 * (no claim add/release/reap, no conflict resolve, no commit/git, no watcher
 * control) and never reads the filesystem in the renderer.
 */

interface CapturedIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  invoke(channel: string, ...args: unknown[]): unknown;
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
}

function createFakeIpc(): CapturedIpc {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler({}, ...args);
    },
    handlers,
  };
}

function makeRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-coord-bridge-'));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('desktop coordination bridge', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    vi.resetModules();
    repo = makeRepo();
  });
  afterEach(() => repo.cleanup());

  test('registers the coordination:getOverview channel', async () => {
    const { registerDesktopCoordinationIpcHandlers } = await import('../../../src/app/desktop/coordination_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopCoordinationIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });
    expect(Array.from(ipc.handlers.keys())).toContain('coordination:getOverview');
  });

  test('coordination:getOverview returns a zeroed empty overview for a fresh repo', async () => {
    const { registerDesktopCoordinationIpcHandlers } = await import('../../../src/app/desktop/coordination_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopCoordinationIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });

    const result = (await ipc.invoke('coordination:getOverview')) as {
      ok: boolean;
      overview?: { agents: { total: number }; claims: { total: number }; conflicts: { unresolved: number } };
    };
    expect(result.ok).toBe(true);
    expect(result.overview?.agents.total).toBe(0);
    expect(result.overview?.claims.total).toBe(0);
    expect(result.overview?.conflicts.unresolved).toBe(0);
  });

  test('coordination:getOverview summarizes registered agents and claims', async () => {
    registerAgent(repo.repoRoot, { agent_name: 'Alice', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { agentId: 'agent-a' });
    addFileClaim(repo.repoRoot, { agent_id: 'agent-a', path: 'src/app.ts', mode: 'exclusive' });

    const { registerDesktopCoordinationIpcHandlers } = await import('../../../src/app/desktop/coordination_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopCoordinationIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });

    const result = (await ipc.invoke('coordination:getOverview')) as {
      ok: boolean;
      overview?: {
        agents: { total: number; items: Array<{ name: string }> };
        claims: { total: number; items: Array<{ path: string }> };
      };
    };
    expect(result.ok).toBe(true);
    expect(result.overview?.agents.total).toBe(1);
    expect(result.overview?.agents.items[0]?.name).toBe('Alice');
    expect(result.overview?.claims.total).toBe(1);
    expect(result.overview?.claims.items[0]?.path).toBe('src/app.ts');
  });

  test('coordination:getOverview returns an error envelope when no repo root resolves', async () => {
    const { registerDesktopCoordinationIpcHandlers } = await import('../../../src/app/desktop/coordination_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopCoordinationIpcHandlers(ipc, { getRepoPath: () => '' });

    const result = (await ipc.invoke('coordination:getOverview')) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('REPO_ROOT_REQUIRED');
  });

  test('reading the overview never writes coordination state to disk', async () => {
    const { registerDesktopCoordinationIpcHandlers } = await import('../../../src/app/desktop/coordination_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopCoordinationIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });

    await ipc.invoke('coordination:getOverview');
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode', 'coordination', 'state.json'))).toBe(false);
  });

  test('does not register any mutation / git / watcher coordination channels', async () => {
    const { registerDesktopCoordinationIpcHandlers } = await import('../../../src/app/desktop/coordination_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopCoordinationIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });

    const channels = Array.from(ipc.handlers.keys());
    const forbidden = /claim|release|reap|resolve|conflict|commit|git|watch|finalize|handoff|add|create|delete|mutate/i;
    for (const channel of channels) {
      // The only allowed channel is the read-only overview getter.
      expect(channel).toBe('coordination:getOverview');
      expect(channel).not.toMatch(forbidden);
    }
  });
});
