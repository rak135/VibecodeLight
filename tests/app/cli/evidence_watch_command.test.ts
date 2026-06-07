import { Command } from 'commander';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { createCli } from '../../../src/app/cli/index.js';
import { registerEvidenceCommands } from '../../../src/app/cli/commands/evidence.js';
import { makeCliStructuredError, emitCliStructuredError } from '../../../src/app/cli/structured_output.js';
import type {
  LiveCoordinationWatcher,
  LiveWatcherOptions,
  LiveWatcherStatus,
} from '../../../src/core/coordination/live_watcher.js';

/**
 * Phase 4D CLI: `vibecode evidence watch` foreground lifecycle command.
 *
 * The command is exercised through INJECTED seams (a fake watcher factory and a
 * fake shutdown waiter) so the test never spawns a real fs.watch watcher and
 * never blocks on real OS signals — only command construction, argument
 * validation, and start/stop wiring are verified.
 */

function runningStatus(overrides: Partial<LiveWatcherStatus> = {}): LiveWatcherStatus {
  return {
    status: 'running',
    started_at: '2026-01-01T00:00:00.000Z',
    stopped_at: null,
    last_event_at: null,
    observed_count: 0,
    recorded_count: 0,
    ignored_count: 0,
    error_count: 0,
    ...overrides,
  };
}

class FakeWatcher implements LiveCoordinationWatcher {
  startCalls = 0;
  stopCalls = 0;
  constructor(private readonly startResult: LiveWatcherStatus = runningStatus()) {}
  async start(): Promise<LiveWatcherStatus> {
    this.startCalls += 1;
    return this.startResult;
  }
  async stop(): Promise<LiveWatcherStatus> {
    this.stopCalls += 1;
    return { ...this.startResult, status: 'stopped', stopped_at: '2026-01-01T00:01:00.000Z' };
  }
  getStatus(): LiveWatcherStatus {
    return this.startResult;
  }
}

interface Harness {
  program: Command;
  watchers: FakeWatcher[];
  capturedOptions: LiveWatcherOptions[];
  shutdownWaits: number;
  logs: string[];
}

function makeHarness(startResult?: LiveWatcherStatus): Harness {
  const program = new Command();
  const watchers: FakeWatcher[] = [];
  const capturedOptions: LiveWatcherOptions[] = [];
  const harness: Harness = { program, watchers, capturedOptions, shutdownWaits: 0, logs: [] };
  registerEvidenceCommands(program, {
    makeCliStructuredError,
    emitCliStructuredError,
    watch: {
      createWatcher: (options: LiveWatcherOptions): LiveCoordinationWatcher => {
        capturedOptions.push(options);
        const watcher = new FakeWatcher(startResult);
        watchers.push(watcher);
        return watcher;
      },
      waitForShutdown: async (): Promise<void> => {
        harness.shutdownWaits += 1;
      },
    },
  });
  return harness;
}

async function run(harness: Harness, argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exitCode;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  process.exitCode = 0;
  try {
    await harness.program.parseAsync(['node', 'vibecode', ...argv]);
    return { stdout: logs.join('\n'), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExit;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('vibecode evidence watch — registration', () => {
  test('the watch subcommand is registered under evidence', () => {
    const program = createCli();
    const evidence = program.commands.find((c) => c.name() === 'evidence');
    expect(evidence).toBeDefined();
    const watch = evidence!.commands.find((c) => c.name() === 'watch');
    expect(watch).toBeDefined();
  });
});

describe('vibecode evidence watch — lifecycle wiring', () => {
  test('startup starts the watcher, waits for shutdown, then stops it cleanly', async () => {
    const harness = makeHarness();
    const { stdout } = await run(harness, ['evidence', 'watch', '--repo', process.cwd(), '--json']);

    expect(harness.watchers).toHaveLength(1);
    expect(harness.watchers[0].startCalls).toBe(1);
    expect(harness.shutdownWaits).toBe(1);
    expect(harness.watchers[0].stopCalls).toBe(1);

    // A startup JSON envelope is printed.
    const lines = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0].ok).toBe(true);
    expect(lines[0].data.status.status).toBe('running');
    // A shutdown envelope is printed last.
    expect(lines[lines.length - 1].data.status.status).toBe('stopped');
  });

  test('--debounce-ms and --agent are forwarded to the watcher factory', async () => {
    const harness = makeHarness();
    await run(harness, ['evidence', 'watch', '--repo', process.cwd(), '--agent', 'agent-a', '--debounce-ms', '500', '--json']);
    expect(harness.capturedOptions).toHaveLength(1);
    expect(harness.capturedOptions[0].debounce_ms).toBe(500);
    expect(harness.capturedOptions[0].agent_id).toBe('agent-a');
  });

  test('an invalid --debounce-ms is a structured error and the watcher is never started', async () => {
    const harness = makeHarness();
    const { stdout, exitCode } = await run(harness, ['evidence', 'watch', '--repo', process.cwd(), '--debounce-ms', 'abc', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('INVALID_ARGUMENT');
    expect(exitCode).toBe(1);
    expect(harness.watchers).toHaveLength(0);
  });

  test('a watcher that fails to start surfaces an error envelope and exit code 1', async () => {
    const harness = makeHarness(runningStatus({ status: 'errored', error_count: 1, last_error: 'watch unavailable' }));
    const { stdout, exitCode } = await run(harness, ['evidence', 'watch', '--repo', process.cwd(), '--json']);
    const lines = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0].ok).toBe(false);
    expect(exitCode).toBe(1);
    // It still attempts a clean stop after a failed start.
    expect(harness.watchers[0].stopCalls).toBe(1);
  });
});
