import fs from 'fs';

import {
  getScanSummary,
  SCAN_SUMMARY_MAX_ITEMS,
  type ScanSummaryResult,
} from '../../../core/runs/scan_summary.js';
import { buildMcpError, type McpErrorCode } from '../errors.js';
import { formatError, formatSimpleSuccess, type McpToolFormattedResult } from '../format.js';
import {
  rejectUnknownKeys,
  validateBoundedInteger,
  validateNonEmptyString,
  SCAN_SUMMARY_INPUT_SCHEMA,
  type JsonSchema,
} from '../schemas.js';
import type { McpToolDefinition, McpToolHandlerInput } from '../tool_registry.js';
import { selectRunForMcp } from './_run_select.js';

/**
 * Phase 1B-2 — `vibecode_scan_summary`.
 *
 * Compact, bounded orientation from existing deterministic scan artifacts for a
 * selected run. Thin wrapper over the shared core service
 * (`core/runs/scan_summary`) — the same service the `vibecode scan summary` CLI
 * command uses, so MCP and CLI return equivalent data. Read-only: it reads only
 * allowlisted scan artifacts (no arbitrary paths, no source files) and NEVER
 * runs the scanner. For full detail of one section an agent follows up with
 * `vibecode_scan_artifact_read`.
 */
const TOOL_NAME = 'vibecode_scan_summary';
const ALLOWED_KEYS = new Set(['run_id', 'sections', 'max_items']);

interface ScanSummaryData extends ScanSummaryResult {
  run_id: string;
  run_ref: string;
}

function renderText(data: ScanSummaryData): string {
  const lines: string[] = ['# Vibecode scan summary', ''];
  lines.push(`run_id: ${data.run_id} (ref ${data.run_ref})`);
  lines.push(`scan_available: ${data.scan_available ? 'yes' : 'no'} scan_dir_available: ${data.scan_dir_available ? 'yes' : 'no'}`);
  lines.push(`available_artifacts: ${data.available_artifacts.join(', ') || '(none)'}`);
  lines.push(`missing_artifacts: ${data.missing_artifacts.join(', ') || '(none)'}`);
  lines.push('', 'sections:');
  for (const name of data.sections_requested) {
    const section = data.sections[name];
    if (!section) continue;
    if (!section.available) {
      lines.push(`  - ${name}: unavailable`);
      continue;
    }
    const head = `  - ${name}: total=${section.total} returned=${section.returned}${section.truncated ? ' (truncated)' : ''}`;
    lines.push(head);
    for (const item of section.items.slice(0, 5)) {
      lines.push(`      ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    }
  }
  if (data.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const w of data.warnings) lines.push(`  - ${w}`);
  }
  lines.push('', 'recommended_next_tools:');
  for (const t of data.recommended_next_tools) lines.push(`  - ${t}`);
  lines.push('', 'Read full section detail with vibecode_artifact_read. These tools do not run the scanner.');
  return lines.join('\n');
}

export function buildScanSummaryTool(): McpToolDefinition {
  const inputSchema: JsonSchema = SCAN_SUMMARY_INPUT_SCHEMA;
  return {
    name: TOOL_NAME,
    title: 'Vibecode scan summary',
    description:
      'Compact, bounded orientation from existing deterministic scan artifacts for a run: per-section counts and top items for files, commands, tests, symbols, imports, entrypoints, instructions, tooling, and git, plus which allowlisted scan artifacts are available/missing. Read-only — reads only allowlisted scan artifacts and never runs the scanner. run_id accepts "latest"/"current". Follow up with vibecode_artifact_read for full detail.',
    inputSchema,
    handler: async (input: McpToolHandlerInput): Promise<McpToolFormattedResult> => {
      const started = Date.now();
      const fail = (code: McpErrorCode, message: string): McpToolFormattedResult =>
        formatError({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          warnings: [],
          durationMs: Date.now() - started,
          error: buildMcpError(code, message),
        });

      const args = (input.arguments ?? {}) as Record<string, unknown>;
      const unknown = rejectUnknownKeys(args, ALLOWED_KEYS);
      if (!unknown.ok) return fail('INVALID_ARGUMENT', unknown.message);

      // run_id is optional; default to current.
      let runSelector = 'current';
      if (args.run_id !== undefined && args.run_id !== null) {
        const runId = validateNonEmptyString(args.run_id, 'run_id');
        if (!runId.ok) return fail('INVALID_ARGUMENT', runId.message);
        runSelector = runId.value;
      }

      // sections is optional; must be an array of strings when present. Core
      // validates membership and returns INVALID_SECTION (→ INVALID_ARGUMENT).
      let sections: string[] | undefined;
      if (args.sections !== undefined && args.sections !== null) {
        if (!Array.isArray(args.sections) || !args.sections.every((s) => typeof s === 'string')) {
          return fail('INVALID_ARGUMENT', `invalid sections: expected an array of strings, got ${JSON.stringify(args.sections)}`);
        }
        sections = args.sections as string[];
      }

      const maxItems = validateBoundedInteger(args.max_items, 'max_items', SCAN_SUMMARY_MAX_ITEMS);
      if (!maxItems.ok) return fail('INVALID_ARGUMENT', maxItems.message);

      const selected = selectRunForMcp({
        tool: TOOL_NAME,
        repoRoot: input.context.repoRoot,
        selector: runSelector,
        durationMsRef: () => Date.now() - started,
      });
      if (!selected.ok) return selected.error;

      if (!fs.existsSync(selected.runDir)) {
        return fail('RUN_NOT_FOUND', `run not found: ${selected.runId}`);
      }

      try {
        const result = getScanSummary(selected.runDir, { sections, maxItems: maxItems.value });
        if (!result.ok) {
          // INVALID_SECTION / INVALID_MAX_ITEMS are both argument problems.
          return fail('INVALID_ARGUMENT', result.error.message);
        }
        const data: ScanSummaryData = {
          run_id: selected.runId,
          run_ref: runSelector,
          ...result.value,
        };
        return formatSimpleSuccess({
          tool: TOOL_NAME,
          repoRoot: input.context.repoRoot,
          text: renderText(data),
          data,
          warnings: result.value.warnings,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        return fail('SCAN_SUMMARY_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
