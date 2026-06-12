import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addBulkClaims } from '../../../src/core/coordination/bulk_claims.js';

/**
 * Desktop activity observability IPC bridge (read-only).
 *
 * Protected invariant: the renderer reads the activity/attribution overview
 * through a single read-only channel backed by the core observability service.
 * The bridge exposes NO mutation channels (no claim/release/reap/resolve, no
 * commit, no git, no watcher control) and the renderer never reads
 * `.vibecode/` files directly.
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-activity-bridge-'));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

describe('desktop observability bridge', () => {
  let repo: { repoRoot: string; cleanup: () => void };
  beforeEach(() => {
    vi.resetModules();
    repo = makeRepo();
  });
  afterEach(() => repo.cleanup());

  test('registers the observability:getActivityOverview channel only', async () => {
    const { registerDesktopObservabilityIpcHandlers } = await import('../../../src/app/desktop/observability_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopObservabilityIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });
    const channels = Array.from(ipc.handlers.keys());
    expect(channels).toEqual(['observability:getActivityOverview']);
    const forbidden = /claim|release|reap|resolve|conflict|commit|watch|finalize|handoff|add|create|delete|mutate/i;
    for (const channel of channels) expect(channel).not.toMatch(forbidden);
  });

  test('returns the core activity overview for a repo with coordination state', async () => {
    registerAgent(
      repo.repoRoot,
      { agent_name: 'Alice', agent_type: 'custom', metadata: { operating_mode: 'build', task: 't' } },
      { agentId: 'agent-a' },
    );
    addBulkClaims({ repoRoot: repo.repoRoot, agent_id: 'agent-a', paths: ['src/app.ts'], intent: 'w' });

    const { registerDesktopObservabilityIpcHandlers } = await import('../../../src/app/desktop/observability_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopObservabilityIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });

    const result = (await ipc.invoke('observability:getActivityOverview')) as {
      ok: boolean;
      overview?: {
        agents: Array<{ agent_id: string; claimed_path_count: number }>;
        claims: Array<{ path: string; owner_agent_id: string }>;
        workspace_safety: { safety_level: string };
        totals: { agents: number };
      };
    };
    expect(result.ok).toBe(true);
    expect(result.overview?.totals.agents).toBe(1);
    expect(result.overview?.agents[0]?.agent_id).toBe('agent-a');
    expect(result.overview?.claims[0]?.path).toBe('src/app.ts');
    expect(typeof result.overview?.workspace_safety.safety_level).toBe('string');
  });

  test('returns an error envelope when no repo root resolves', async () => {
    const { registerDesktopObservabilityIpcHandlers } = await import('../../../src/app/desktop/observability_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopObservabilityIpcHandlers(ipc, { getRepoPath: () => '' });
    const result = (await ipc.invoke('observability:getActivityOverview')) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('REPO_ROOT_REQUIRED');
  });

  test('reading the overview never writes coordination or log state to disk', async () => {
    const { registerDesktopObservabilityIpcHandlers } = await import('../../../src/app/desktop/observability_bridge.js');
    const ipc = createFakeIpc();
    registerDesktopObservabilityIpcHandlers(ipc, { getRepoPath: () => repo.repoRoot });
    await ipc.invoke('observability:getActivityOverview');
    expect(fs.existsSync(path.join(repo.repoRoot, '.vibecode'))).toBe(false);
  });
});
