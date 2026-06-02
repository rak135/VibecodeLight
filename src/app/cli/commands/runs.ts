import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import { LlmAdapterError } from '../../../adapters/llm/errors.js';
import { createRun } from '../../../core/runs/run_store.js';
import { getRunInfo, listRuns } from '../../../core/runs/run_display.js';
import { getWorkspacePaths } from '../../../core/workspace/paths.js';
import type { RunManifest } from '../../../core/models/index.js';
import type { TaskIntent } from '../../../adapters/task_normalizer/types.js';

function normalizeRunArtifactSelector(selector: string): string {
  const normalized = selector.replace(/\\/g, '/');
  if (normalized === 'codegraph') return 'scan/codegraph_usage.json';
  if (normalized === 'task-intent') return 'task_intent.json';
  return normalized;
}

const RUN_SHOW_ARTIFACTS = new Set([
  'user_prompt.md',
  'run_manifest.json',
  'task_intent.json',
  'task_intent.md',
  'scanner_config.json',
  'flash/flash_input.md',
  'flash/flash_output.md',
  'output/context_pack.md',
  'skills/selected_skills.json',
  'output/final_prompt.md',
  'terminal/send_metadata.json',
  'scan/codegraph_usage.json',
  'scan/codegraph_context.md',
  'scan/codegraph_repo_atlas.md',
  'scan/codegraph_repo_atlas.json',
  'scan/repo_atlas.md',
  'scan/repo_atlas.json',
]);

function resolveRunArtifactPath(runDir: string, selector: string): { relativePath: string; absolutePath: string } {
  const relativePath = normalizeRunArtifactSelector(selector);
  if (!RUN_SHOW_ARTIFACTS.has(relativePath)) {
    throw new LlmAdapterError(`artifact path is not allowed: ${selector}`, {
      code: 'ARTIFACT_NOT_ALLOWED',
      path: selector,
      details: Array.from(RUN_SHOW_ARTIFACTS).sort(),
    });
  }
  const runRoot = path.resolve(runDir);
  const artifactPath = path.resolve(runRoot, ...relativePath.split('/'));
  const relToRun = path.relative(runRoot, artifactPath);
  if (relToRun.startsWith('..') || path.isAbsolute(relToRun)) {
    throw new LlmAdapterError(`artifact path resolves outside run directory: ${selector}`, {
      code: 'ARTIFACT_NOT_ALLOWED',
      path: selector,
      details: [],
    });
  }
  if (!fs.existsSync(artifactPath)) {
    throw new LlmAdapterError(`artifact not found: ${relativePath}`, {
      code: 'ARTIFACT_NOT_FOUND',
      path: artifactPath,
      details: [],
    });
  }
  return { relativePath, absolutePath: artifactPath };
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

export function resolveRunDir(repoRoot: string, runSelector: string): { runId: string; runDir: string } {
  const paths = getWorkspacePaths(repoRoot);
  if (runSelector === 'latest') {
    const currentManifestPath = path.join(paths.current, 'run_manifest.json');
    if (!fs.existsSync(currentManifestPath)) {
      throw new LlmAdapterError('no latest run found; run context-build first', {
        code: 'RUN_NOT_FOUND',
        path: currentManifestPath,
        details: ['Expected .vibecode/current/run_manifest.json to identify the latest run.'],
      });
    }

    const manifest = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8')) as Partial<RunManifest>;
    if (!manifest.run_id) {
      throw new LlmAdapterError('latest run manifest does not contain run_id', {
        code: 'RUN_MANIFEST_INVALID',
        path: currentManifestPath,
        details: [],
      });
    }
    return { runId: manifest.run_id, runDir: path.join(paths.runs, manifest.run_id) };
  }

  return { runId: runSelector, runDir: path.join(paths.runs, runSelector) };
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
}
