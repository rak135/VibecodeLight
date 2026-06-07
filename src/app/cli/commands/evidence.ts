import path from 'path';

import { Command } from 'commander';

import {
  listCoordinationEvidence,
  scanChangedFilesToEvidence,
  summarizeEvidence,
} from '../../../core/coordination/watcher.js';
import {
  createLiveCoordinationWatcher,
  type LiveCoordinationWatcher,
  type LiveWatcherOptions,
} from '../../../core/coordination/live_watcher.js';
import type { CoordinationEvidenceEvent } from '../../../core/coordination/watcher_events.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

/**
 * Injectable seams for the foreground `evidence watch` command. Production uses
 * the real live watcher and an OS-signal waiter; tests inject a fake watcher and
 * an immediately-resolving waiter so command wiring is covered WITHOUT real
 * fs.watch timing or real OS signals.
 */
export interface EvidenceWatchSeams {
  createWatcher?: (options: LiveWatcherOptions) => LiveCoordinationWatcher;
  waitForShutdown?: () => Promise<void>;
}

export interface EvidenceCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
  watch?: EvidenceWatchSeams;
}

/** Default shutdown waiter: resolve on the first SIGINT/SIGTERM. */
function defaultWaitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = (): void => resolve();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

/**
 * Register `vibecode evidence …` commands (Phase 4C watcher evidence).
 *
 * `list` reads `.vibecode/coordination/events.jsonl`; `scan` records evidence
 * for the current dirty git working tree. Both are thin wrappers over the shared
 * core service (`core/coordination/watcher`) — the same service the
 * `vibecode_evidence_*` MCP tools use. Evidence is advisory and NON-ENFORCING:
 * these commands never block writes, never mutate source files, and never stage,
 * commit, or otherwise mutate git. `scan` writes only generated evidence state.
 */
export function registerEvidenceCommands(
  program: Command,
  dependencies: EvidenceCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  const evidence = program
    .command('evidence')
    .description('Multi-agent coordination: watcher evidence (advisory; non-enforcing)');

  evidence
    .command('list')
    .description('List recorded coordination evidence events (read-only)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--limit <n>', 'Return only the newest <n> events')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; limit?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const limit = parseLimit(options.limit);
      if (limit === 'invalid') {
        emitCliStructuredError(
          makeCliStructuredError('INVALID_ARGUMENT', '--limit must be a non-negative integer.', repoRoot),
          { json: options.json, prefix: 'evidence list failed' },
        );
        return;
      }
      try {
        const events = listCoordinationEvidence({ repoRoot, limit });
        emitSuccess(options.json, { events, summary: summarizeEvidence(events) });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError('EVIDENCE_LIST_FAILED', errorMessage(error), repoRoot),
          { json: options.json, prefix: 'evidence list failed' },
        );
      }
    });

  evidence
    .command('scan')
    .description('Record evidence for the current dirty git working tree (read-only against git/source)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Coordinating agent id for the scan context')
    .option('--run <run_id>', 'Run id whose agent_binding.json resolves the agent context')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; agent?: string; run?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      let result;
      try {
        result = scanChangedFilesToEvidence({ repoRoot, agent_id: options.agent, run_id: options.run });
      } catch (error) {
        emitCliStructuredError(
          makeCliStructuredError('EVIDENCE_SCAN_FAILED', errorMessage(error), repoRoot),
          { json: options.json, prefix: 'evidence scan failed' },
        );
        return;
      }

      if (!result.ok) {
        emitCliStructuredError(
          makeCliStructuredError(
            'EVIDENCE_SCAN_FAILED',
            `Unable to read git changed files: ${result.warnings.join('; ')}`,
            repoRoot,
            result.warnings,
          ),
          { json: options.json, prefix: 'evidence scan failed' },
        );
        return;
      }

      emitSuccess(options.json, { events: result.events, summary: summarizeEvidence(result.events) });
    });

  const createWatcher = dependencies.watch?.createWatcher ?? createLiveCoordinationWatcher;
  const waitForShutdown = dependencies.watch?.waitForShutdown ?? defaultWaitForShutdown;

  evidence
    .command('watch')
    .description('Start a live coordination evidence watcher (foreground; advisory, non-enforcing)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Coordinating agent id for the watch context')
    .option('--run <run_id>', 'Run id whose agent_binding.json resolves the agent context')
    .option('--debounce-ms <n>', 'Debounce window in milliseconds for coalescing noisy events')
    .option('--json', 'Output canonical JSON envelopes (startup + shutdown)')
    .action(async (options: { repo: string; agent?: string; run?: string; debounceMs?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const debounceMs = parseDebounce(options.debounceMs);
      if (debounceMs === 'invalid') {
        emitCliStructuredError(
          makeCliStructuredError('INVALID_ARGUMENT', '--debounce-ms must be a non-negative integer.', repoRoot),
          { json: options.json, prefix: 'evidence watch failed' },
        );
        return;
      }

      const watcher = createWatcher({
        repoRoot,
        agent_id: options.agent,
        run_id: options.run,
        debounce_ms: debounceMs,
      });

      const startStatus = await watcher.start();
      if (startStatus.status === 'errored') {
        // Surface the failure, still attempt a clean stop, and exit non-zero.
        emitCliStructuredError(
          makeCliStructuredError('EVIDENCE_WATCH_FAILED', startStatus.last_error ?? 'watcher failed to start', repoRoot),
          { json: options.json, prefix: 'evidence watch failed' },
        );
        await watcher.stop();
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({ ok: true, data: { status: startStatus }, artifacts: [], warnings: [] }));
      } else {
        console.log(`watching ${repoRoot} (debounce=${debounceMs ?? 'default'} status=${startStatus.status}); press Ctrl+C to stop`);
      }

      try {
        await waitForShutdown();
      } finally {
        const stopStatus = await watcher.stop();
        if (options.json) {
          console.log(JSON.stringify({ ok: true, data: { status: stopStatus }, artifacts: [], warnings: [] }));
        } else {
          console.log(`stopped (observed=${stopStatus.observed_count} recorded=${stopStatus.recorded_count} ignored=${stopStatus.ignored_count} errors=${stopStatus.error_count})`);
        }
      }
    });
}

function parseDebounce(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 'invalid';
  return value;
}

function parseLimit(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 'invalid';
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitSuccess(
  json: boolean | undefined,
  data: { events: CoordinationEvidenceEvent[]; summary: ReturnType<typeof summarizeEvidence> },
): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: [] }));
    return;
  }
  const s = data.summary;
  console.log(`events=${s.recent_count} warnings=${s.warning_count} high=${s.high_count} last=${s.last_event_at ?? '(none)'}`);
  for (const event of data.events) {
    console.log(`  [${event.severity}] ${event.classification} ${event.path}`);
  }
}
