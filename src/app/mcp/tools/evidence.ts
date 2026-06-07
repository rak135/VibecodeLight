import {
  listCoordinationEvidence,
  scanChangedFilesToEvidence,
  summarizeEvidence,
} from '../../../core/coordination/watcher.js';
import type { CoordinationEvidenceEvent } from '../../../core/coordination/watcher_events.js';
import { buildMcpError } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateNonEmptyString,
  validatePositiveInteger,
  EVIDENCE_LIST_INPUT_SCHEMA,
  EVIDENCE_SCAN_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';

/**
 * Phase Coordination-4C: watcher evidence tools.
 *
 * `vibecode_evidence_list` is read-only; `vibecode_evidence_scan` writes ONLY
 * generated coordination state (`.vibecode/coordination/events.jsonl`) — exactly
 * like the advisory claim tools, and unlike the commit guard it performs NO git
 * or source mutation. Evidence is NON-ENFORCING: it records that a path changed
 * relative to the active advisory claims and never asserts physical edit
 * attribution, never blocks writes, and never stages/commits.
 *
 * Both tools are thin wrappers over the shared core service
 * (`core/coordination/watcher`) — the same service the `vibecode evidence …` CLI
 * commands use. The repo is bound to the server at startup; neither tool accepts
 * a repo argument and neither shells out to the CLI.
 */

function summaryLines(events: CoordinationEvidenceEvent[]): string[] {
  const s = summarizeEvidence(events);
  const lines = [
    `events=${s.recent_count} warnings=${s.warning_count} high=${s.high_count} last=${s.last_event_at ?? '(none)'}`,
  ];
  for (const event of events) {
    lines.push(`  - [${event.severity}] ${event.classification} ${event.path}`);
  }
  return lines;
}

export function buildEvidenceListTool(): McpToolDefinition {
  const inputSchema: JsonSchema = EVIDENCE_LIST_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_evidence_list';
  const ALLOWED_KEYS = new Set(['limit']);
  return {
    name: TOOL_NAME,
    title: 'List coordination evidence',
    description:
      'List watcher evidence events for the bound repo from .vibecode/coordination/events.jsonl, each classifying a changed path relative to active advisory claims (claimed_by_agent / claimed_by_other_active_agent / unclaimed / generated_or_ignored). Advisory and non-enforcing — evidence records that a path changed, never who physically edited it. Read-only.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('INVALID_ARGUMENT', message),
        });

      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail(unknown.message);
      const args = input.arguments ?? {};
      const limit = validatePositiveInteger(args.limit, 'limit');
      if (!limit.ok) return fail(limit.message);

      try {
        const events = listCoordinationEvidence({ repoRoot: input.context.repoRoot, limit: limit.value });
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: ['# Vibecode coordination evidence', '', ...summaryLines(events)].join('\n'),
          data: { events, summary: summarizeEvidence(events) },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError('EVIDENCE_LIST_FAILED', err instanceof Error ? err.message : String(err)),
        });
      }
    },
  };
}

export function buildEvidenceScanTool(): McpToolDefinition {
  const inputSchema: JsonSchema = EVIDENCE_SCAN_INPUT_SCHEMA;
  const TOOL_NAME = 'vibecode_evidence_scan';
  const ALLOWED_KEYS = new Set(['agent_id', 'run_id']);
  return {
    name: TOOL_NAME,
    title: 'Scan changed files into evidence',
    description:
      'Scan the bound repo’s current dirty git working tree and record one evidence event per changed file, classified relative to active advisory claims. Reads git read-only and writes ONLY generated .vibecode/coordination/events.jsonl — never stages, commits, or mutates git or source files. Advisory and non-enforcing. Pass agent_id or run_id to set the scan context.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: 'INVALID_ARGUMENT' | 'EVIDENCE_SCAN_FAILED', message: string, details?: Record<string, unknown>): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, message, details ? { details } : {}),
        });

      const unknown = rejectUnknownKeys(input.arguments, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);
      const args = input.arguments ?? {};
      const agentId = args.agent_id === undefined || args.agent_id === null
        ? undefined
        : validateNonEmptyString(args.agent_id, 'agent_id');
      if (agentId && !agentId.ok) return fail('INVALID_ARGUMENT', agentId.message);
      const runId = args.run_id === undefined || args.run_id === null
        ? undefined
        : validateNonEmptyString(args.run_id, 'run_id');
      if (runId && !runId.ok) return fail('INVALID_ARGUMENT', runId.message);

      try {
        const result = scanChangedFilesToEvidence({
          repoRoot: input.context.repoRoot,
          agent_id: agentId ? agentId.value : undefined,
          run_id: runId ? runId.value : undefined,
        });
        if (!result.ok) {
          return fail('EVIDENCE_SCAN_FAILED', `Unable to read git changed files: ${result.warnings.join('; ')}`, {
            warnings: result.warnings,
          });
        }
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: ['# Vibecode coordination evidence (scan)', '', ...summaryLines(result.events)].join('\n'),
          data: { events: result.events, summary: summarizeEvidence(result.events) },
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('EVIDENCE_SCAN_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
