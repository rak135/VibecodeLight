import fs from 'fs';
import path from 'path';

import { isGeneratedOrIgnoredRuntimePath } from '../workspace/git_changed_files.js';
import { recordFileChangeEvidence } from './watcher.js';
import type { EvidenceSource } from './watcher_events.js';

/**
 * Phase 4D live watcher lifecycle (non-enforcing).
 *
 * This is a small, deterministic lifecycle service wrapped around the existing
 * Phase 4C evidence core (`recordFileChangeEvidence`). It can start watching a
 * workspace, debounce/coalesce noisy filesystem events per path, ignore
 * generated/runtime paths, and stop cleanly — feeding observed changes into the
 * advisory evidence log.
 *
 * Core truth (same as Phase 4C): in one shared working tree Vibecode cannot know
 * which agent physically edited a file. The watcher therefore only ever records
 * that a path CHANGED relative to the active advisory claims. It NEVER:
 *   - blocks or delays a write,
 *   - mutates source files,
 *   - stages/commits/resets/cleans/checks-out git,
 *   - creates/resolves claims,
 *   - asserts physical edit attribution.
 *
 * Enforcement remains with the finalize check and the scoped commit guard.
 *
 * Backend decision: chokidar is intentionally NOT a dependency. The default
 * backend is a thin `fs.watch` adapter (recursive watch, supported on the
 * Windows/macOS targets). All lifecycle/debounce logic is exercised through an
 * INJECTED fake backend + injected scheduler so there are no fragile real-time
 * watcher tests.
 */

/** Lifecycle state of a live watcher. */
export type LiveWatcherStatusValue = 'stopped' | 'starting' | 'running' | 'stopping' | 'errored';

/** A raw event surfaced by a {@link FileWatchBackend}. */
export interface RawWatchEvent {
  /** Backend path (absolute, or repo-relative); normalized internally. */
  path: string;
  event_type: 'change' | 'rename' | 'delete' | 'unknown';
  /** Optional compact backend label retained as evidence metadata (never content). */
  raw_event?: string;
}

/** A handle returned by a backend so the watcher can close it. */
export interface FileWatchHandle {
  close(): Promise<void> | void;
}

/** Input handed to a backend when the watcher starts. */
export interface FileWatchBackendStartInput {
  repoRoot: string;
  /** Predicate the backend may use to drop generated/runtime paths early. */
  ignored: (path: string) => boolean;
  onEvent: (event: RawWatchEvent) => void;
  onError: (error: Error) => void;
}

/** A pluggable filesystem-watch backend (real fs.watch or a fake in tests). */
export interface FileWatchBackend {
  start(input: FileWatchBackendStartInput): Promise<FileWatchHandle> | FileWatchHandle;
}

/** Opaque debounce timer handle (a Node timer, or a fake id in tests). */
export type DebounceTimerHandle = unknown;

/** Injectable scheduler abstraction so debounce is deterministic in tests. */
export interface DebounceScheduler {
  schedule(fn: () => void, ms: number): DebounceTimerHandle;
  cancel(handle: DebounceTimerHandle): void;
}

/** Read-only snapshot of a watcher's lifecycle + counters. */
export interface LiveWatcherStatus {
  status: LiveWatcherStatusValue;
  started_at: string | null;
  stopped_at: string | null;
  last_event_at: string | null;
  observed_count: number;
  recorded_count: number;
  ignored_count: number;
  error_count: number;
  last_error?: string;
}

export interface LiveWatcherOptions {
  repoRoot: string;
  agent_id?: string;
  run_id?: string;
  debounce_ms?: number;
  /** Test seam: deterministic clock. */
  now?: () => Date | string;
  /** Test seam: deterministic evidence event ids. */
  eventId?: () => string;
  /** Backend override; defaults to the thin fs.watch backend. */
  backend?: FileWatchBackend;
  /** Scheduler override; defaults to setTimeout/clearTimeout. */
  scheduler?: DebounceScheduler;
  /** Evidence source label (defaults to 'fs_watch'). */
  source?: EvidenceSource;
}

/** The live watcher instance. */
export interface LiveCoordinationWatcher {
  start(): Promise<LiveWatcherStatus>;
  stop(): Promise<LiveWatcherStatus>;
  getStatus(): LiveWatcherStatus;
}

/** Default debounce window: coalesces editor save-storms per path. */
export const DEFAULT_DEBOUNCE_MS = 250;

const defaultScheduler: DebounceScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toIso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/**
 * Normalize a backend path to a repo-relative, forward-slash path. Backends may
 * emit absolute paths (fs.watch) or already-relative paths (tests). Paths that
 * resolve outside the repo root yield `''` so they are treated as ignored.
 */
export function toRepoRelativePath(repoRoot: string, rawPath: string): string {
  if (!rawPath) return '';
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
  const relative = path.relative(repoRoot, absolute).replace(/\\/g, '/').replace(/^\.\//, '');
  if (relative === '' || relative === '..' || relative.startsWith('../')) return '';
  return relative;
}

// In-process registry: exposes the running watcher's status WITHOUT a generated
// status file. Cross-process watcher status is intentionally NOT pretended here.
let activeWatcher: LiveCoordinationWatcher | null = null;

/** Status of the live watcher running in THIS process, or null if none. */
export function getActiveLiveWatcherStatus(): LiveWatcherStatus | null {
  return activeWatcher ? activeWatcher.getStatus() : null;
}

/**
 * Create a live coordination watcher. The watcher is inert until {@link
 * LiveCoordinationWatcher.start} is called and is safe to {@link
 * LiveCoordinationWatcher.stop} at any time.
 */
export function createLiveCoordinationWatcher(options: LiveWatcherOptions): LiveCoordinationWatcher {
  const repoRoot = options.repoRoot;
  const debounceMs = options.debounce_ms ?? DEFAULT_DEBOUNCE_MS;
  const scheduler = options.scheduler ?? defaultScheduler;
  const backend = options.backend ?? createFsWatchBackend();
  const source: EvidenceSource = options.source ?? 'fs_watch';

  const status: LiveWatcherStatus = {
    status: 'stopped',
    started_at: null,
    stopped_at: null,
    last_event_at: null,
    observed_count: 0,
    recorded_count: 0,
    ignored_count: 0,
    error_count: 0,
  };

  let handle: FileWatchHandle | null = null;
  // Debounce: one pending timer per normalized path; the latest raw label wins.
  const pending = new Map<string, { timer: DebounceTimerHandle; rawEvent?: string }>();

  function currentNow(): Date | string {
    return options.now ? options.now() : new Date();
  }

  function noteError(error: unknown): void {
    status.error_count += 1;
    status.last_error = errorMessage(error);
  }

  function ignored(rawPath: string): boolean {
    const relative = toRepoRelativePath(repoRoot, rawPath);
    return relative === '' || isGeneratedOrIgnoredRuntimePath(relative);
  }

  function recordPath(relativePath: string, rawEvent?: string): void {
    try {
      recordFileChangeEvidence({
        repoRoot,
        path: relativePath,
        raw_event: rawEvent,
        agent_id: options.agent_id,
        run_id: options.run_id,
        now: currentNow(),
        source,
        eventId: options.eventId ? options.eventId() : undefined,
      });
      status.recorded_count += 1;
    } catch (error) {
      // Evidence is non-enforcing: a failed append must never crash the watcher.
      noteError(error);
    }
  }

  function flushPath(relativePath: string): void {
    const entry = pending.get(relativePath);
    if (!entry) return;
    pending.delete(relativePath);
    recordPath(relativePath, entry.rawEvent);
  }

  function onEvent(event: RawWatchEvent): void {
    status.observed_count += 1;
    status.last_event_at = toIso(currentNow());
    const relative = toRepoRelativePath(repoRoot, event.path);
    if (relative === '' || isGeneratedOrIgnoredRuntimePath(relative)) {
      status.ignored_count += 1;
      return;
    }
    const existing = pending.get(relative);
    if (existing) scheduler.cancel(existing.timer);
    const rawEvent = event.raw_event ?? event.event_type;
    const timer = scheduler.schedule(() => flushPath(relative), debounceMs);
    pending.set(relative, { timer, rawEvent });
  }

  function onError(error: Error): void {
    // A transient watch error is recorded but does not tear down the watcher.
    noteError(error);
  }

  async function start(): Promise<LiveWatcherStatus> {
    if (status.status === 'running' || status.status === 'starting') {
      return getStatus(); // idempotent: never open a second backend
    }
    status.status = 'starting';
    try {
      handle = await backend.start({ repoRoot, ignored, onEvent, onError });
      status.status = 'running';
      status.started_at = toIso(currentNow());
      status.stopped_at = null;
      activeWatcher = instance;
    } catch (error) {
      status.status = 'errored';
      noteError(error);
      handle = null;
    }
    return getStatus();
  }

  async function stop(): Promise<LiveWatcherStatus> {
    if (status.status === 'stopped') {
      return getStatus(); // safe no-op (also covers stop-before-start)
    }
    status.status = 'stopping';
    // Flush pending debounced events so observed changes are not silently lost.
    for (const [relativePath, entry] of [...pending.entries()]) {
      scheduler.cancel(entry.timer);
      pending.delete(relativePath);
      recordPath(relativePath, entry.rawEvent);
    }
    try {
      if (handle) await handle.close();
    } catch (error) {
      noteError(error);
    } finally {
      handle = null;
      status.status = 'stopped';
      status.stopped_at = toIso(currentNow());
      if (activeWatcher === instance) activeWatcher = null;
    }
    return getStatus();
  }

  function getStatus(): LiveWatcherStatus {
    return { ...status };
  }

  const instance: LiveCoordinationWatcher = { start, stop, getStatus };
  return instance;
}

/**
 * Thin default backend over `fs.watch` (recursive). Kept deliberately small and
 * untested-by-timing: all lifecycle/debounce behavior is covered through the
 * injected fake backend. It maps coarse fs.watch event types and applies the
 * `ignored` predicate before surfacing an event.
 */
export function createFsWatchBackend(): FileWatchBackend {
  return {
    start({ repoRoot, ignored, onEvent, onError }: FileWatchBackendStartInput): FileWatchHandle {
      const watcher = fs.watch(repoRoot, { recursive: true }, (eventType, filename) => {
        try {
          if (!filename) return;
          const relative = filename.toString();
          if (ignored(relative)) return;
          onEvent({
            path: relative,
            event_type: eventType === 'rename' ? 'rename' : eventType === 'change' ? 'change' : 'unknown',
            raw_event: eventType,
          });
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      });
      watcher.on('error', (error: unknown) => {
        onError(error instanceof Error ? error : new Error(String(error)));
      });
      return { close: () => watcher.close() };
    },
  };
}
