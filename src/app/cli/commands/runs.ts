import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import { LlmAdapterError } from '../../../adapters/llm/errors.js';
import { createRun } from '../../../core/runs/run_store.js';
import { getRunInfo, listRuns } from '../../../core/runs/run_display.js';
import {
  RUN_SHOW_ARTIFACTS,
  resolveRunArtifactPath as resolveRunArtifactPathCore,
} from '../../../core/runs/run_artifacts.js';
import {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  HARD_MAX_ARTIFACT_CHUNK_BYTES,
  readRunArtifactChunk,
} from '../../../core/runs/artifact_pagination.js';
import { resolveRunDir as resolveRunDirCore } from '../../../core/runs/run_resolver.js';
import { getWorkspacePaths } from '../../../core/workspace/paths.js';
import type { TaskIntent } from '../../../adapters/task_normalizer/types.js';

function resolveRunArtifactPath(runDir: string, selector: string): { relativePath: string; absolutePath: string } {
  const resolved = resolveRunArtifactPathCore(runDir, selector, {
    allowlist: RUN_SHOW_ARTIFACTS,
    applyAliases: true,
  });
  if (resolved.ok) return resolved.value;

  // Preserve the historical CLI mapping: both ARTIFACT_NOT_ALLOWED and
  // PATH_OUTSIDE_RUN surfaced as ARTIFACT_NOT_ALLOWED, ARTIFACT_NOT_FOUND
  // surfaced as ARTIFACT_NOT_FOUND. Details/paths are kept compatible with
  // the CLI envelopes already exercised by existing tests.
  if (resolved.error.code === 'ARTIFACT_NOT_ALLOWED') {
    throw new LlmAdapterError(resolved.error.message, {
      code: 'ARTIFACT_NOT_ALLOWED',
      path: selector,
      details: resolved.error.allowed ?? Array.from(RUN_SHOW_ARTIFACTS).sort(),
    });
  }
  if (resolved.error.code === 'PATH_OUTSIDE_RUN') {
    throw new LlmAdapterError(resolved.error.message, {
      code: 'ARTIFACT_NOT_ALLOWED',
      path: selector,
      details: [],
    });
  }
  throw new LlmAdapterError(resolved.error.message, {
    code: 'ARTIFACT_NOT_FOUND',
    path: resolved.error.resolvedPath ?? selector,
    details: [],
  });
}

function readTaskIntentSummary(runDir: string): TaskIntent | undefined {
  const taskIntentPath = path.join(runDir, 'task_intent.json');
  if (!fs.existsSync(taskIntentPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(taskIntentPath, 'utf8')) as TaskIntent;
  } catch {
    return undefined;
  }
}

function writeTaskIntentSummary(intent: TaskIntent | undefined): void {
  console.log('Task Normalizer:');
  if (!intent) {
    console.log('  status: not present');
    return;
  }
  console.log(`  enabled: ${intent.enabled ? 'yes' : 'no'}`);
  console.log(`  ok: ${intent.ok ? 'yes' : 'no'}`);
  console.log(`  language: ${intent.original_language}`);
  if (intent.enabled && intent.ok) {
    console.log(`  normalized English task: ${intent.normalized_english_task || '—'}`);
    console.log(`  search hints: ${intent.search_hints.length > 0 ? intent.search_hints.join(', ') : '—'}`);
  }
  if (intent.warnings.length > 0) {
    console.log('  warnings:');
    for (const warning of intent.warnings) console.log(`    - ${warning}`);
  }
  console.log('  artifacts:');
  console.log('    - task_intent.json');
  console.log('    - task_intent.md');
}

function codeGraphRelativeArtifactLines(info: ReturnType<typeof getRunInfo>): string[] {
  const candidates: Array<[string, string | undefined]> = [
    ['scan/codegraph_usage.json', info.artifacts.codegraph_usage],
    ['scan/codegraph_context.md', info.artifacts.codegraph_context],
    ['scan/codegraph_repo_atlas.md', info.artifacts.codegraph_repo_atlas],
    ['scan/codegraph_repo_atlas.json', info.artifacts.codegraph_repo_atlas_json],
    ['scan/repo_atlas.md (compat)', info.artifacts.repo_atlas],
    ['scan/repo_atlas.json (compat)', info.artifacts.repo_atlas_json],
  ];
  return candidates.filter(([, artifactPath]) => Boolean(artifactPath)).map(([relativePath]) => relativePath);
}

function writeCodeGraphSummary(info: ReturnType<typeof getRunInfo>): void {
  const cg = info.codegraph;
  console.log('CodeGraph:');
  console.log(`  status: ${cg.state}`);
  console.log(`  mode: ${cg.mode ?? 'unknown'}`);
  console.log(`  used for context: ${cg.usedForContext ? 'yes' : 'no'}`);
  console.log(`  reason: ${cg.usageReason}`);
  console.log(`  usage note: ${cg.usageNote}`);
  console.log(`  CodeGraph-derived Repo Atlas: ${cg.repoAtlasGenerated ? 'generated' : 'not generated'}`);
  console.log(`  CodeGraph-derived Repo Atlas reason: ${cg.repoAtlasReason}`);
  console.log(`  CodeGraph-derived Repo Atlas note: ${cg.repoAtlasNote}`);
  const artifacts = codeGraphRelativeArtifactLines(info);
  console.log('  artifacts:');
  if (artifacts.length === 0) {
    console.log('    - none');
  } else {
    for (const artifact of artifacts) console.log(`    - ${artifact}`);
  }
  const warnings = cg.displayWarnings.length > 0 ? cg.displayWarnings : cg.warnings;
  if (warnings.length > 0) {
    console.log('  warnings:');
    for (const warning of warnings) console.log(`    - ${warning}`);
  }
}

/**
 * Re-export of the shared core run-dir resolver. Kept here so CLI call sites
 * (and any test that imports `resolveRunDir` from this module) continue to
 * work; the implementation lives in `src/core/runs/run_resolver.ts` and is
 * shared with the Desktop and (future) MCP adapters.
 */
export const resolveRunDir = resolveRunDirCore;

interface ArtifactReadEnvelopeError {
  code: string;
  message: string;
  path: string;
  details: string[];
}

type ArtifactReadEnvelope =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ArtifactReadEnvelopeError };

/**
 * Agent-facing artifact continuation read shared by the `vibecode runs
 * artifact-read` JSON and human output paths. Thin adapter over the core
 * {@link readRunArtifactChunk} service so it stays in parity with the MCP
 * `vibecode_artifact_read` tool (same allowlist, aliases, byte-offset, UTF-8
 * safety, hashing, and bounds). Never throws; returns a structured envelope.
 */
function buildArtifactReadEnvelope(args: {
  repoRoot: string;
  run: string;
  artifact: string;
  byteOffset?: number;
  maxBytes?: number;
}): ArtifactReadEnvelope {
  let resolvedRun: { runId: string; runDir: string };
  try {
    resolvedRun = resolveRunDir(args.repoRoot, args.run);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'RUN_NOT_FOUND',
        message: err instanceof Error ? err.message : String(err),
        path: args.run,
        details: [],
      },
    };
  }
  if (!fs.existsSync(resolvedRun.runDir)) {
    return {
      ok: false,
      error: { code: 'RUN_NOT_FOUND', message: `run not found: ${resolvedRun.runId}`, path: resolvedRun.runDir, details: [] },
    };
  }

  const read = readRunArtifactChunk(resolvedRun.runDir, args.artifact, {
    allowlist: RUN_SHOW_ARTIFACTS,
    applyAliases: true,
    byteOffset: args.byteOffset,
    maxBytes: args.maxBytes,
  });
  if (!read.ok) {
    let code: string;
    if (read.error.code === 'ARTIFACT_NOT_ALLOWED' || read.error.code === 'PATH_OUTSIDE_RUN') {
      code = 'ARTIFACT_NOT_ALLOWED';
    } else if (read.error.code === 'ARTIFACT_NOT_FOUND') {
      code = 'ARTIFACT_NOT_FOUND';
    } else {
      // INVALID_BYTE_OFFSET / INVALID_MAX_BYTES / BYTE_OFFSET_OUT_OF_RANGE
      code = 'INVALID_ARGUMENT';
    }
    return {
      ok: false,
      error: {
        code,
        message: read.error.message,
        path: read.error.resolvedPath ?? args.artifact,
        details: read.error.allowed ?? [],
      },
    };
  }

  const chunk = read.value;
  return {
    ok: true,
    data: {
      run_id: resolvedRun.runId,
      run_dir: resolvedRun.runDir,
      artifact: args.artifact,
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
    },
  };
}

export function registerRunCreateCommand(program: Command): void {
  const run = program.command('run').description('Run operations');
  run
    .command('create <task>')
    .description('Create a new run package')
    .action(async (task: string) => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      const result = await createRun({ vibecodePath: paths.vibecode, task, repoRoot: root });
      console.log(result.run_id);
    });
}

export function registerRunsCommands(program: Command): void {
  const runs = program.command('runs').description('Run inspection commands');

  runs
    .command('list')
    .description('List VibecodeLight runs')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const paths = getWorkspacePaths(repoRoot);
      const infos = listRuns(paths.vibecode, paths.runs);

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: { runs: infos },
          artifacts: [],
          warnings: [],
        }));
        return;
      }

      console.log('run_id\tcreated_at\ttask\thas_final_prompt');
      for (const info of infos) {
        const task = info.task.length > 80 ? `${info.task.slice(0, 77)}...` : info.task;
        console.log(`${info.run_id}\t${info.created_at}\t${task}\t${info.has_final_prompt ? 'yes' : 'no'}`);
      }
    });

  runs
    .command('show <runId>')
    .description('Show a VibecodeLight run')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .option('--artifact <name>', 'Print a whitelisted run artifact (for example codegraph or scan/codegraph_repo_atlas.md)')
    .action((runId: string, options: { repo: string; json?: boolean; artifact?: string }) => {
      const repoRoot = path.resolve(options.repo);
      const paths = getWorkspacePaths(repoRoot);
      let resolvedRun: { runId: string; runDir: string };
      try {
        resolvedRun = resolveRunDir(repoRoot, runId);
      } catch (err) {
        const error = {
          code: 'RUN_NOT_FOUND',
          message: err instanceof Error ? err.message : String(err),
          path: runId === 'latest' ? path.join(paths.current, 'run_manifest.json') : path.join(paths.runs, runId),
          details: [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`runs show failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (!fs.existsSync(resolvedRun.runDir)) {
        const error = {
          code: 'RUN_NOT_FOUND',
          message: `run not found: ${resolvedRun.runId}`,
          path: resolvedRun.runDir,
          details: [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`runs show failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (options.artifact) {
        try {
          const artifact = resolveRunArtifactPath(resolvedRun.runDir, options.artifact);
          process.stdout.write(fs.readFileSync(artifact.absolutePath, 'utf8'));
        } catch (err) {
          const error = err instanceof LlmAdapterError ? {
            code: err.code,
            message: err.message,
            path: err.path ?? options.artifact,
            details: err.details,
          } : {
            code: 'ARTIFACT_READ_FAILED',
            message: err instanceof Error ? err.message : String(err),
            path: options.artifact,
            details: [],
          };
          if (options.json) console.log(JSON.stringify({ ok: false, error }));
          else console.error(`runs show failed: ${error.message}`);
          process.exitCode = 1;
        }
        return;
      }

      const info = getRunInfo(resolvedRun.runDir);
      const taskIntent = readTaskIntentSummary(resolvedRun.runDir);
      const artifacts = Object.values(info.artifacts).filter((value): value is string => typeof value === 'string');

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: taskIntent ? { ...info, task_intent: taskIntent } : info,
          artifacts,
          warnings: [],
        }));
        return;
      }

      console.log(`run: ${info.run_id}`);
      console.log(`task: ${info.task}`);
      console.log(`repo: ${info.repo_root}`);
      console.log(`created: ${info.created_at}`);
      console.log(`runDir: ${info.runDir}`);
      console.log(`final_prompt: ${info.artifacts.final_prompt ?? 'not found'}`);
      console.log(`send_metadata: ${info.artifacts.send_metadata ?? 'not present'}`);
      writeTaskIntentSummary(taskIntent);
      writeCodeGraphSummary(info);
      console.log('artifacts:');
      const artifactLines: Array<[string, string | undefined]> = [
        ['user_prompt.md', info.artifacts.user_prompt],
        ['run_manifest.json', info.artifacts.run_manifest],
        ['task_intent.json', taskIntent ? path.join(resolvedRun.runDir, 'task_intent.json') : undefined],
        ['task_intent.md', taskIntent ? path.join(resolvedRun.runDir, 'task_intent.md') : undefined],
        ['scanner_config.json', info.artifacts.scanner_config],
        ['flash/flash_input.md', info.artifacts.flash_input],
        ['flash/flash_output.md', info.artifacts.flash_output],
        ['output/context_pack.md', info.artifacts.context_pack],
        ['skills/selected_skills.json', info.artifacts.selected_skills],
        ['output/final_prompt.md', info.artifacts.final_prompt],
        ['terminal/send_metadata.json', info.artifacts.send_metadata],
        ['scan/codegraph_usage.json', info.artifacts.codegraph_usage],
        ['scan/codegraph_context.md', info.artifacts.codegraph_context],
        ['scan/codegraph_repo_atlas.md (CodeGraph-derived Repo Atlas)', info.artifacts.codegraph_repo_atlas],
        ['scan/codegraph_repo_atlas.json', info.artifacts.codegraph_repo_atlas_json],
        ['scan/repo_atlas.md (compat CodeGraph-derived Repo Atlas)', info.artifacts.repo_atlas],
        ['scan/repo_atlas.json (compat)', info.artifacts.repo_atlas_json],
      ];
      for (const [label, artifactPath] of artifactLines) {
        console.log(`  ${label}: ${artifactPath ? 'exists' : 'missing'}`);
      }
    });

  runs
    .command('artifact-read')
    .description('Read an allowlisted run artifact as a bounded, continuation-friendly chunk (agent-facing JSON)')
    .requiredOption('--artifact <name>', 'Allowlisted artifact name (for example final_prompt, context_pack, flash_output, codegraph)')
    .option('--run <id>', 'Run id, or one of the aliases "latest"/"current"', 'latest')
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
      // Parse numeric flags loosely; core performs the authoritative validation
      // (non-negative integer / positive bounded integer) and returns structured
      // errors, keeping the CLI a thin adapter over the shared service.
      const byteOffset = options.byteOffset === undefined ? undefined : Number(options.byteOffset);
      const maxBytes = options.maxBytes === undefined ? undefined : Number(options.maxBytes);

      const result = buildArtifactReadEnvelope({
        repoRoot,
        run: options.run,
        artifact: options.artifact,
        byteOffset,
        maxBytes,
      });

      if (!result.ok) {
        if (options.json) console.log(JSON.stringify({ ok: false, error: result.error }));
        else console.error(`runs artifact-read failed: [${result.error.code}] ${result.error.message}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({ ok: true, data: result.data, artifacts: [], warnings: [] }));
        return;
      }

      const data = result.data as Record<string, unknown> & { content: string };
      console.log(`artifact: ${data.relative_path}`);
      console.log(`run_id: ${data.run_id}`);
      console.log(`byte_offset: ${data.byte_offset}`);
      console.log(`bytes_read: ${data.bytes_read}`);
      console.log(`total_bytes: ${data.total_bytes}`);
      console.log(`has_more: ${data.has_more ? 'yes' : 'no'}`);
      console.log(`next_byte_offset: ${data.next_byte_offset ?? 'null'}`);
      console.log(`content_sha256: ${data.content_sha256}`);
      if (data.has_more) {
        console.log(`continue: vibecode runs artifact-read --run ${data.run_id} --artifact ${options.artifact} --byte-offset ${data.next_byte_offset} --json`);
      }
      console.log('---');
      process.stdout.write(data.content);
    });
}
