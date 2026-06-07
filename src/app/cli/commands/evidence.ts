import path from 'path';

import { Command } from 'commander';

import {
  listCoordinationEvidence,
  scanChangedFilesToEvidence,
  summarizeEvidence,
} from '../../../core/coordination/watcher.js';
import type { CoordinationEvidenceEvent } from '../../../core/coordination/watcher_events.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface EvidenceCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
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
