import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  HARD_MAX_ARTIFACT_CHUNK_BYTES,
} from '../../../core/runs/artifact_pagination.js';
import { normalizeRunSelector, resolveRunDir } from '../../../core/runs/run_resolver.js';
import { readScanArtifactChunk } from '../../../core/runs/scan_artifacts.js';
import {
  getScanSummary,
  SCAN_SUMMARY_MAX_ITEMS,
  type ScanSummaryResult,
} from '../../../core/runs/scan_summary.js';
import {
  type EmitCliStructuredError,
  type MakeCliStructuredError,
} from '../structured_output.js';

export interface ScanReadCommandDependencies {
  makeCliStructuredError: MakeCliStructuredError;
  emitCliStructuredError: EmitCliStructuredError;
}

/**
 * Register the Phase 1B-2 read-only scan subcommands on the existing
 * `vibecode scan` command:
 *
 *   - `vibecode scan summary` — compact bounded summary of existing scan
 *     artifacts (parity with the MCP `vibecode_scan_summary` tool);
 *   - `vibecode scan artifact-read` — bounded, continuation-friendly read of one
 *     allowlisted scan artifact (parity with `vibecode_scan_artifact_read`).
 *
 * Both are thin wrappers over the shared core services so CLI and MCP stay in
 * lockstep. They are read-only, never run the scanner, and never read arbitrary
 * paths or source files. The legacy `vibecode scan <task>` form (which runs the
 * scanner) is unaffected — Commander routes the `summary` / `artifact-read`
 * subcommand names ahead of the positional task argument, and any other token is
 * still treated as the task to scan.
 */
export function registerScanReadCommands(
  scan: Command,
  dependencies: ScanReadCommandDependencies,
): void {
  const { makeCliStructuredError, emitCliStructuredError } = dependencies;

  scan
    .command('summary')
    .description('Compact bounded summary of existing scan artifacts for a run (read-only; does not run the scanner)')
    .option('--run <id>', 'Run id, or one of the aliases "latest"/"current"', 'current')
    .option('--sections <list>', 'Comma-separated subset of sections (files,commands,tests,symbols,imports,entrypoints,instructions,tooling,git)')
    .option('--max-items <n>', 'Cap on per-section item lists')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: {
      run: string;
      sections?: string;
      maxItems?: string;
      repo: string;
      json?: boolean;
    }) => {
      const repoRoot = path.resolve(options.repo);

      let sections: string[] | undefined;
      if (options.sections !== undefined) {
        sections = options.sections.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }

      let maxItems: number | undefined;
      if (options.maxItems !== undefined) {
        const raw = Number(options.maxItems);
        if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
          emitCliStructuredError(
            makeCliStructuredError('INVALID_ARGUMENT', `invalid --max-items: expected a positive integer, got ${JSON.stringify(options.maxItems)}`, repoRoot),
            { json: options.json, prefix: 'scan summary failed' },
          );
          return;
        }
        if (raw > SCAN_SUMMARY_MAX_ITEMS) {
          emitCliStructuredError(
            makeCliStructuredError('INVALID_ARGUMENT', `invalid --max-items: value ${raw} exceeds maximum ${SCAN_SUMMARY_MAX_ITEMS}`, repoRoot),
            { json: options.json, prefix: 'scan summary failed' },
          );
          return;
        }
        maxItems = raw;
      }

      let resolved: { runId: string; runDir: string };
      try {
        resolved = resolveRunDir(repoRoot, normalizeRunSelector(options.run));
      } catch (err) {
        emitCliStructuredError(
          makeCliStructuredError('RUN_NOT_FOUND', err instanceof Error ? err.message : String(err), options.run),
          { json: options.json, prefix: 'scan summary failed' },
        );
        return;
      }
      if (!fs.existsSync(resolved.runDir)) {
        emitCliStructuredError(
          makeCliStructuredError('RUN_NOT_FOUND', `run not found: ${resolved.runId}`, resolved.runDir),
          { json: options.json, prefix: 'scan summary failed' },
        );
        return;
      }

      const result = getScanSummary(resolved.runDir, { sections, maxItems });
      if (!result.ok) {
        const details = 'allowed' in result.error ? result.error.allowed : [];
        emitCliStructuredError(
          makeCliStructuredError('INVALID_ARGUMENT', result.error.message, options.run, details),
          { json: options.json, prefix: 'scan summary failed' },
        );
        return;
      }

      const data = { run_id: resolved.runId, run_ref: options.run, ...result.value };

      if (options.json) {
        console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: result.value.warnings }));
        return;
      }
      printHumanSummary(data);
    });

  scan
    .command('artifact-read')
    .description('Read one allowlisted scan artifact as a bounded, continuation-friendly chunk (read-only; does not run the scanner)')
    .requiredOption('--artifact <name>', 'Allowlisted scan artifact key (for example commands, tests, symbols, imports, file_inventory, git_status)')
    .option('--run <id>', 'Run id, or one of the aliases "latest"/"current"', 'current')
    .option('--byte-offset <n>', 'Byte offset into the original artifact file (default 0). Pass the previous response next_byte_offset to continue.')
    .option('--max-bytes <n>', `Max bytes of UTF-8 content to return for this chunk (default ${DEFAULT_ARTIFACT_CHUNK_BYTES}, max ${HARD_MAX_ARTIFACT_CHUNK_BYTES})`)
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: {
      artifact: string;
      run: string;
      byteOffset?: string;
      maxBytes?: string;
      repo: string;
      json?: boolean;
    }) => {
      const repoRoot = path.resolve(options.repo);
      const byteOffset = options.byteOffset === undefined ? undefined : Number(options.byteOffset);
      const maxBytes = options.maxBytes === undefined ? undefined : Number(options.maxBytes);

      let resolved: { runId: string; runDir: string };
      try {
        resolved = resolveRunDir(repoRoot, normalizeRunSelector(options.run));
      } catch (err) {
        emitCliStructuredError(
          makeCliStructuredError('RUN_NOT_FOUND', err instanceof Error ? err.message : String(err), options.run),
          { json: options.json, prefix: 'scan artifact-read failed' },
        );
        return;
      }
      if (!fs.existsSync(resolved.runDir)) {
        emitCliStructuredError(
          makeCliStructuredError('RUN_NOT_FOUND', `run not found: ${resolved.runId}`, resolved.runDir),
          { json: options.json, prefix: 'scan artifact-read failed' },
        );
        return;
      }

      const read = readScanArtifactChunk(resolved.runDir, options.artifact, { byteOffset, maxBytes });
      if (!read.ok) {
        let code: string;
        if (read.error.code === 'ARTIFACT_NOT_ALLOWED' || read.error.code === 'PATH_OUTSIDE_RUN') {
          code = 'ARTIFACT_NOT_ALLOWED';
        } else if (read.error.code === 'ARTIFACT_NOT_FOUND') {
          code = 'ARTIFACT_NOT_FOUND';
        } else {
          code = 'INVALID_ARGUMENT';
        }
        emitCliStructuredError(
          makeCliStructuredError(code, read.error.message, read.error.resolvedPath ?? options.artifact, read.error.allowed ?? []),
          { json: options.json, prefix: 'scan artifact-read failed' },
        );
        return;
      }

      const chunk = read.value;
      const data = {
        run_id: resolved.runId,
        run_dir: resolved.runDir,
        artifact: chunk.artifact,
        relative_path: chunk.relativePath,
        absolute_path: chunk.absolutePath,
        byte_offset: chunk.byteOffset,
        requested_max_bytes: chunk.requestedMaxBytes,
        bytes_read: chunk.bytesRead,
        total_bytes: chunk.totalBytes,
        has_more: chunk.hasMore,
        next_byte_offset: chunk.nextByteOffset,
        content_sha256: chunk.contentSha256,
        truncated: chunk.hasMore,
        content: chunk.content,
      };

      if (options.json) {
        console.log(JSON.stringify({ ok: true, data, artifacts: [], warnings: [] }));
        return;
      }

      console.log(`artifact: ${data.relative_path} (${data.artifact})`);
      console.log(`run_id: ${data.run_id}`);
      console.log(`byte_offset: ${data.byte_offset}`);
      console.log(`bytes_read: ${data.bytes_read}`);
      console.log(`total_bytes: ${data.total_bytes}`);
      console.log(`has_more: ${data.has_more ? 'yes' : 'no'}`);
      console.log(`next_byte_offset: ${data.next_byte_offset ?? 'null'}`);
      console.log(`content_sha256: ${data.content_sha256}`);
      if (data.has_more) {
        console.log(`continue: vibecode scan artifact-read --run ${data.run_id} --artifact ${data.artifact} --byte-offset ${data.next_byte_offset} --json`);
      }
      console.log('---');
      process.stdout.write(data.content);
    });
}

function printHumanSummary(data: ScanSummaryResult & { run_id: string; run_ref: string }): void {
  console.log(`run_id: ${data.run_id} (ref ${data.run_ref})`);
  console.log(`scan_available: ${data.scan_available ? 'yes' : 'no'} scan_dir_available: ${data.scan_dir_available ? 'yes' : 'no'}`);
  console.log(`available_artifacts: ${data.available_artifacts.join(', ') || '(none)'}`);
  console.log(`missing_artifacts: ${data.missing_artifacts.join(', ') || '(none)'}`);
  console.log('sections:');
  for (const name of data.sections_requested) {
    const section = data.sections[name];
    if (!section) continue;
    if (!section.available) {
      console.log(`  ${name}: unavailable`);
      continue;
    }
    console.log(`  ${name}: total=${section.total} returned=${section.returned}${section.truncated ? ' (truncated)' : ''}`);
  }
  if (data.warnings.length > 0) {
    console.log('warnings:');
    for (const w of data.warnings) console.log(`  - ${w}`);
  }
  console.log('recommended_next_tools:');
  for (const t of data.recommended_next_tools) console.log(`  - ${t}`);
}
