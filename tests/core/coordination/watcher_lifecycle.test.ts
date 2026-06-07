import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim } from '../../../src/core/coordination/claims.js';
import {
  createLiveCoordinationWatcher,
  getActiveLiveWatcherStatus,
  type DebounceScheduler,
  type DebounceTimerHandle,
  type FileWatchBackend,
  type FileWatchHandle,
  type RawWatchEvent,
} from '../../../src/core/coordination/live_watcher.js';
import { readEvidenceEvents } from '../../../src/core/coordination/watcher_events.js';

/**
 * Phase 4D watcher lifecycle (injected fake backend) — non-enforcing.
 *
 * These tests drive the lifecycle through an INJECTED fake backend and an
 * injected manual scheduler so there is no dependency on real fs.watch timing.
 * The watcher only ever appends advisory evidence; it never blocks writes,
 * never mutates source files, and never mutates git.
 */

const T0 = '2026-01-01T00:00:00.000Z';

const created: string[] = [];
function makeRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A manual scheduler: timers fire only when the test calls flush(). */
class ManualScheduler implements DebounceScheduler {
  private seq = 0;
  private readonly timers = new Map<number, () => void>();

  schedule(fn: () => void): DebounceTimerHandle {
    const id = this.seq++;
    this.timers.set(id, fn);
    return id as unknown as DebounceTimerHandle;
  }

  cancel(handle: DebounceTimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  flush(): void {
    const entries = [...this.timers.values()];
    this.timers.clear();
    for (const fn of entries) fn();
  }
}

/** A controllable fake backend that captures the handlers and reports calls. */
class FakeBackend implements FileWatchBackend {
  startCalls = 0;
  closeCalls = 0;
  lastIgnored: ((p: string) => boolean) | null = null;
  private onEvent: ((e: RawWatchEvent) => void) | null = null;
  private onError: ((e: Error) => void) | null = null;

  constructor(private readonly opts: { failStart?: Error; failClose?: Error } = {}) {}

  start(input: {
    repoRoot: string;
    ignored: (p: string) => boolean;
    onEvent: (e: RawWatchEvent) => void;
    onError: (e: Error) => void;
  }): FileWatchHandle {
    this.startCalls += 1;
    if (this.opts.failStart) throw this.opts.failStart;
    this.lastIgnored = input.ignored;
    this.onEvent = input.onEvent;
    this.onError = input.onError;
    const self = this;
    return {
      close(): void {
        self.closeCalls += 1;
        if (self.opts.failClose) throw self.opts.failClose;
      },
    };
  }

  emit(event: RawWatchEvent): void {
    this.onEvent?.(event);
  }

  emitError(error: Error): void {
    this.onError?.(error);
  }
}

describe('createLiveCoordinationWatcher — lifecycle', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo('vibecode-live-watch-');
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a', now: T0 });
  });

  test('start transitions stopped → running and opens the backend once', async () => {
    const backend = new FakeBackend();
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    expect(watcher.getStatus().status).toBe('stopped');
    const status = await watcher.start();
    expect(status.status).toBe('running');
    expect(status.started_at).not.toBeNull();
    expect(backend.startCalls).toBe(1);
    await watcher.stop();
  });

  test('stop transitions running → stopped and closes the backend handle', async () => {
    const backend = new FakeBackend();
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    await watcher.start();
    const status = await watcher.stop();
    expect(status.status).toBe('stopped');
    expect(status.stopped_at).not.toBeNull();
    expect(backend.closeCalls).toBe(1);
  });

  test('start twice is idempotent: the backend is opened only once', async () => {
    const backend = new FakeBackend();
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    await watcher.start();
    const second = await watcher.start();
    expect(second.status).toBe('running');
    expect(backend.startCalls).toBe(1);
    await watcher.stop();
  });

  test('stop before start is safe and stays stopped', async () => {
    const backend = new FakeBackend();
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    const status = await watcher.stop();
    expect(status.status).toBe('stopped');
    expect(backend.startCalls).toBe(0);
    expect(backend.closeCalls).toBe(0);
  });

  test('a backend that fails to start sets status errored and increments error_count without throwing', async () => {
    const backend = new FakeBackend({ failStart: new Error('watch unavailable') });
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    const status = await watcher.start();
    expect(status.status).toBe('errored');
    expect(status.error_count).toBeGreaterThanOrEqual(1);
    expect(status.last_error).toContain('watch unavailable');
  });

  test('a runtime backend error increments error_count without crashing the watcher', async () => {
    const backend = new FakeBackend();
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    await watcher.start();
    backend.emitError(new Error('transient'));
    const status = watcher.getStatus();
    expect(status.error_count).toBeGreaterThanOrEqual(1);
    expect(status.last_error).toContain('transient');
    // The watcher is still running and usable.
    expect(status.status).toBe('running');
    await watcher.stop();
  });

  test('a close failure is recorded but the watcher still reaches stopped', async () => {
    const backend = new FakeBackend({ failClose: new Error('close boom') });
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    await watcher.start();
    const status = await watcher.stop();
    expect(status.status).toBe('stopped');
    expect(status.error_count).toBeGreaterThanOrEqual(1);
    expect(status.last_error).toContain('close boom');
  });
});

describe('createLiveCoordinationWatcher — debounce & evidence recording', () => {
  let repo: string;
  let scheduler: ManualScheduler;
  let backend: FakeBackend;
  beforeEach(() => {
    repo = makeRepo('vibecode-live-watch-rec-');
    registerAgent(repo, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a', now: T0 });
    scheduler = new ManualScheduler();
    backend = new FakeBackend();
  });

  test('a single source-file event records exactly one evidence event with source fs_watch', async () => {
    const watcher = createLiveCoordinationWatcher({
      repoRoot: repo,
      agent_id: 'agent-a',
      backend,
      scheduler,
      now: () => T0,
    });
    await watcher.start();
    backend.emit({ path: 'src/a.ts', event_type: 'change', raw_event: 'change' });
    expect(scheduler.pending).toBe(1);
    scheduler.flush();

    const events = readEvidenceEvents(repo);
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe('src/a.ts');
    expect(events[0].classification).toBe('unclaimed');
    expect(events[0].evidence.source).toBe('fs_watch');
    expect(watcher.getStatus().recorded_count).toBe(1);
    await watcher.stop();
  });

  test('duplicate events for the same path within the debounce window coalesce into one evidence event', async () => {
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, agent_id: 'agent-a', backend, scheduler, now: () => T0 });
    await watcher.start();
    backend.emit({ path: 'src/a.ts', event_type: 'change' });
    backend.emit({ path: 'src/a.ts', event_type: 'change' });
    backend.emit({ path: 'src/a.ts', event_type: 'change' });
    expect(scheduler.pending).toBe(1);
    scheduler.flush();

    expect(readEvidenceEvents(repo).filter((e) => e.path === 'src/a.ts')).toHaveLength(1);
    expect(watcher.getStatus().observed_count).toBe(3);
    expect(watcher.getStatus().recorded_count).toBe(1);
    await watcher.stop();
  });

  test('events for different paths record separate evidence events', async () => {
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, agent_id: 'agent-a', backend, scheduler, now: () => T0 });
    await watcher.start();
    backend.emit({ path: 'src/a.ts', event_type: 'change' });
    backend.emit({ path: 'src/b.ts', event_type: 'change' });
    expect(scheduler.pending).toBe(2);
    scheduler.flush();

    const paths = readEvidenceEvents(repo).map((e) => e.path).sort();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    await watcher.stop();
  });

  test('generated/runtime paths are ignored before recording (no evidence, ignored_count increments)', async () => {
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, agent_id: 'agent-a', backend, scheduler, now: () => T0 });
    await watcher.start();
    backend.emit({ path: '.vibecode/coordination/events.jsonl', event_type: 'change' });
    backend.emit({ path: '.git/index', event_type: 'change' });
    backend.emit({ path: 'node_modules/x/index.js', event_type: 'change' });
    backend.emit({ path: '.codegraph/db.sqlite', event_type: 'change' });
    expect(scheduler.pending).toBe(0);
    scheduler.flush();

    expect(readEvidenceEvents(repo)).toEqual([]);
    expect(watcher.getStatus().ignored_count).toBe(4);
    expect(watcher.getStatus().recorded_count).toBe(0);
    await watcher.stop();
  });

  test('classification reuses the shared path classification (claimed_by_agent for a held claim)', async () => {
    addFileClaim(repo, { agent_id: 'agent-a', path: 'src/a.ts', mode: 'exclusive' }, { now: T0 });
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, agent_id: 'agent-a', backend, scheduler, now: () => T0 });
    await watcher.start();
    backend.emit({ path: 'src/a.ts', event_type: 'change' });
    scheduler.flush();
    expect(readEvidenceEvents(repo)[0].classification).toBe('claimed_by_agent');
    await watcher.stop();
  });

  test('stop flushes pending debounced events before reaching stopped', async () => {
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, agent_id: 'agent-a', backend, scheduler, now: () => T0 });
    await watcher.start();
    backend.emit({ path: 'src/a.ts', event_type: 'change' });
    expect(scheduler.pending).toBe(1);
    // No manual flush: stop() must flush the pending event itself.
    await watcher.stop();
    expect(readEvidenceEvents(repo).filter((e) => e.path === 'src/a.ts')).toHaveLength(1);
  });

  test('the watcher never creates or modifies the source files it observes', async () => {
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, agent_id: 'agent-a', backend, scheduler, now: () => T0 });
    await watcher.start();
    backend.emit({ path: 'src/does-not-exist.ts', event_type: 'change' });
    scheduler.flush();
    await watcher.stop();
    // The observed source path was never written by the watcher.
    expect(fs.existsSync(path.join(repo, 'src/does-not-exist.ts'))).toBe(false);
  });

  test('the ignored predicate handed to the backend matches generated runtime roots', async () => {
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler });
    await watcher.start();
    expect(backend.lastIgnored).not.toBeNull();
    expect(backend.lastIgnored!('.git/index')).toBe(true);
    expect(backend.lastIgnored!('node_modules/x.js')).toBe(true);
    expect(backend.lastIgnored!('src/a.ts')).toBe(false);
    await watcher.stop();
  });
});

describe('getActiveLiveWatcherStatus — in-process status (no status file)', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo('vibecode-live-watch-active-');
  });

  test('reports the running in-process watcher and clears on stop; writes no status file', async () => {
    const backend = new FakeBackend();
    const watcher = createLiveCoordinationWatcher({ repoRoot: repo, backend, scheduler: new ManualScheduler() });
    expect(getActiveLiveWatcherStatus()).toBeNull();
    await watcher.start();
    expect(getActiveLiveWatcherStatus()?.status).toBe('running');
    await watcher.stop();
    expect(getActiveLiveWatcherStatus()).toBeNull();
    // No generated watcher_status.json is created (in-memory status only).
    expect(fs.existsSync(path.join(repo, '.vibecode', 'coordination', 'watcher_status.json'))).toBe(false);
  });
});

describe('createLiveCoordinationWatcher — default scheduler (real timers)', () => {
  test('uses a setTimeout-based debounce by default', async () => {
    vi.useFakeTimers();
    try {
      const repo = makeRepo('vibecode-live-watch-timers-');
      registerAgent(repo, { agent_name: 'A', agent_type: 'claude' }, { agentId: 'agent-a', now: T0 });
      const backend = new FakeBackend();
      const watcher = createLiveCoordinationWatcher({
        repoRoot: repo,
        agent_id: 'agent-a',
        backend,
        debounce_ms: 250,
        now: () => T0,
      });
      await watcher.start();
      backend.emit({ path: 'src/a.ts', event_type: 'change' });
      expect(readEvidenceEvents(repo)).toEqual([]);
      vi.advanceTimersByTime(250);
      expect(readEvidenceEvents(repo)).toHaveLength(1);
      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
