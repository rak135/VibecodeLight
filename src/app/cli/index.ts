import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { Command } from 'commander';
import YAML from 'yaml';

import { LlmAdapterError, ProviderNotConfiguredError } from '../../adapters/llm/errors.js';
import { MockFlashAdapter } from '../../adapters/llm/mock_flash.js';
import { OpenAiCompatibleAdapter } from '../../adapters/llm/openai_compatible_adapter.js';
import {
  ensureLocalConfig,
  getConfigPaths,
  resolveFlashConfig,
  syncConfig,
  writeConfigResolution,
} from '../../core/config/index.js';
import { createRun } from '../../core/runs/run_store.js';
import { updateCurrent } from '../../core/runs/current.js';
import { getRunInfo, listRuns } from '../../core/runs/run_display.js';
import { performScanPhase, writeRunManifest } from '../../core/runs/scan_phase.js';
import { initWorkspace } from '../../core/workspace/initializer.js';
import { getWorkspacePaths } from '../../core/workspace/paths.js';
import { RunManifest } from '../../core/models/index.js';
import {
  buildSkillsCatalog,
  discoverProjectSkills,
} from '../../core/skills/catalog.js';
import { copyAllSkills, copySkill } from '../../core/skills/copy.js';
import {
  buildFlashInput,
  buildFlashInputManifest,
  FlashInputManifestError,
  contextFinalizeErrorToDiagnostic,
  enrichFlashOutputMeta,
  finalizeContext,
  formatPreviousRunSummary,
  getPreviousRunSummary,
  parseFlashOutput,
} from '../../core/context/index.js';
import { renderFinalPrompt, runPromptPipeline } from '../../core/prompting/index.js';
import { runTerminalDemo } from '../../core/terminal/index.js';
import { runDesktopSmoke } from '../desktop/desktop_smoke.js';

function pythonAvailable(): boolean {
  const result = spawnSync('python', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

export interface ScanResult {
  status: 'ok' | 'error';
  run_id: string;
  runDir?: string;
  scanDir: string;
  artifacts?: Record<string, string>;
  warnings?: string[];
  diagnostic?: string;
}

export interface ContextBuildResult {
  status: 'ok' | 'error';
  run_id: string;
  runDir: string;
  scanDir: string;
  flashDir: string;
  artifacts?: string[];
  warnings?: string[];
  diagnostic?: string;
  error?: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

export interface FlashRunResult {
  status: 'ok' | 'error';
  run_id?: string;
  runDir?: string;
  flashDir?: string;
  artifacts?: string[];
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

export interface ContextFinalizeCliResult {
  status: 'ok' | 'error';
  run_id?: string;
  runDir?: string;
  artifacts?: string[];
  warnings?: string[];
  missing_skills?: string[];
  error?: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

function toErrorEnvelope(error: unknown, fallbackPath?: string): NonNullable<FlashRunResult['error']> {
  if (error instanceof LlmAdapterError) {
    return {
      code: error.code,
      message: error.message,
      path: error.path ?? fallbackPath,
      details: error.details,
    };
  }

  return {
    code: 'FLASH_RUN_FAILED',
    message: error instanceof Error ? error.message : String(error),
    path: fallbackPath,
    details: [],
  };
}

function resolveRunDir(repoRoot: string, runSelector: string): { runId: string; runDir: string } {
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


export async function runScan(opts: {
  task: string;
  repoRoot: string;
  jsonOutput?: boolean;
}): Promise<ScanResult> {
  const result = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot });

  if (result.status === 'error') {
    return { status: 'error', run_id: result.run_id, scanDir: result.scanDir, diagnostic: result.diagnostic };
  }

  const doneManifest: RunManifest = {
    ...result.manifest,
    status: 'done',
  };
  writeRunManifest(result.runManifestPath, doneManifest);
  await updateCurrent(result.vibecodePath, doneManifest);

  return { status: 'ok', run_id: result.run_id, runDir: result.runDir, scanDir: result.scanDir, artifacts: result.artifacts, warnings: result.warnings };
}

export async function runContextBuild(opts: {
  task: string;
  repoRoot: string;
  jsonOutput?: boolean;
}): Promise<ContextBuildResult> {
  const result = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot });

  if (result.status === 'error') {
    return {
      status: 'error',
      run_id: result.run_id,
      runDir: result.runDir,
      scanDir: result.scanDir,
      flashDir: path.join(result.runDir, 'flash'),
      diagnostic: result.diagnostic,
      error: {
        code: 'SCANNER_FAILED',
        message: result.diagnostic,
        path: result.scanDir,
        details: [],
      },
    };
  }

  const flashDir = path.join(result.runDir, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });

  try {
    const flashManifest = buildFlashInputManifest({
      run_id: result.run_id,
      task: opts.task,
      repo_root: opts.repoRoot,
      runDir: result.runDir,
    });
    const previousRunSummary = formatPreviousRunSummary(
      getPreviousRunSummary({
        vibecodePath: result.vibecodePath,
        currentRunId: result.run_id,
      }),
    );
    const flashInput = buildFlashInput({
      run_id: result.run_id,
      task: opts.task,
      repo_root: opts.repoRoot,
      runDir: result.runDir,
      previousRunSummary,
      manifest: flashManifest,
    });
    const flashManifestPath = path.join(flashDir, 'flash_input_manifest.json');
    const flashInputPath = path.join(flashDir, 'flash_input.md');

    writeRunManifest(result.runManifestPath, {
      ...result.manifest,
      status: 'done',
    });
    await updateCurrent(result.vibecodePath, {
      ...result.manifest,
      status: 'done',
    });

    fs.writeFileSync(flashManifestPath, `${JSON.stringify(flashManifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(flashInputPath, flashInput, 'utf8');

    const artifactPaths = [
      path.join(result.runDir, 'user_prompt.md'),
      result.runManifestPath,
      path.join(result.runDir, 'scanner_config.json'),
      path.join(result.runDir, 'skills', 'skills_catalog.json'),
      ...Object.values(result.artifacts),
      flashManifestPath,
      flashInputPath,
    ];

    return {
      status: 'ok',
      run_id: result.run_id,
      runDir: result.runDir,
      scanDir: result.scanDir,
      flashDir,
      artifacts: [...new Set(artifactPaths)],
      warnings: [...result.warnings, ...flashManifest.warnings],
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const flashManifestPath = path.join(flashDir, 'flash_input_manifest.json');
    const failureManifest: RunManifest = {
      ...result.manifest,
      status: 'error',
    };
    writeRunManifest(result.runManifestPath, failureManifest);
    await updateCurrent(result.vibecodePath, failureManifest);

    const typedError = error as Partial<FlashInputManifestError> & { details?: string[] };
    return {
      status: 'error',
      run_id: result.run_id,
      runDir: result.runDir,
      scanDir: result.scanDir,
      flashDir,
      diagnostic,
      error: {
        code: typedError.code ?? 'FLASH_INPUT_BUILD_FAILED',
        message: diagnostic,
        path: typedError.path ?? flashManifestPath,
        details: Array.isArray(typedError.details) ? typedError.details : [],
      },
    };
  }
}

export async function runFlash(opts: {
  runSelector: string;
  repoRoot: string;
  mock?: boolean;
  live?: boolean;
}): Promise<FlashRunResult> {
  let resolvedRun: { runId: string; runDir: string } | undefined;

  try {
    resolvedRun = resolveRunDir(opts.repoRoot, opts.runSelector);
    const { runId, runDir } = resolvedRun;
    const flashDir = path.join(runDir, 'flash');
    const flashInputPath = path.join(flashDir, 'flash_input.md');

    if (!fs.existsSync(runDir)) {
      throw new LlmAdapterError(`run not found: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        path: runDir,
        details: [],
      });
    }

    if (!fs.existsSync(flashInputPath)) {
      throw new LlmAdapterError(`missing flash_input.md for run ${runId}`, {
        code: 'FLASH_INPUT_NOT_FOUND',
        path: flashInputPath,
        details: ['Run context-build before flash run, or choose a run containing flash/flash_input.md.'],
      });
    }

    const flashInputMd = fs.readFileSync(flashInputPath, 'utf8');

    const resolved = resolveFlashConfig({
      repoRoot: opts.repoRoot,
      env: process.env,
      live: opts.live,
      mock: opts.mock,
    });

    let adapterResult;
    if (!opts.mock) {
      if (!resolved.providerConfig) {
        throw new ProviderNotConfiguredError('no flash provider configured; set provider config in the local/global config or AppData .env, or use --mock', {
          path: flashInputPath,
          details: resolved.error?.details ?? [],
        });
      }

      if (!opts.live) {
        throw new LlmAdapterError(
          'live model calls are disabled in normal flash run; use --mock for tests/smoke or pass --live with provider configuration',
          { code: 'LIVE_PROVIDER_DISABLED', path: flashInputPath, details: ['Default flash run does not call real providers.'] },
        );
      }

      const liveAdapter = new OpenAiCompatibleAdapter(resolved.providerConfig);
      adapterResult = await liveAdapter.run({ flashInputMd, runId, workspaceRoot: opts.repoRoot });
    } else {
      const adapter = new MockFlashAdapter();
      adapterResult = await adapter.run({ flashInputMd, runId, workspaceRoot: opts.repoRoot });
    }

    const configResolutionPath = writeConfigResolution(runDir, resolved.resolution);
    const adapterMeta = adapterResult.meta as Record<string, unknown>;
    enrichFlashOutputMeta(flashDir, {
      provider: (typeof adapterMeta.provider === 'string' ? adapterMeta.provider : resolved.resolution.provider) ?? null,
      model: (typeof adapterMeta.model === 'string' ? adapterMeta.model : resolved.resolution.model) ?? null,
      live: typeof adapterMeta.live === 'boolean' ? adapterMeta.live : false,
      baseUrl_host: (typeof adapterMeta.baseUrl_host === 'string' ? adapterMeta.baseUrl_host : resolved.resolution.baseUrl_host) ?? null,
      config_source: resolved.resolution.selected_config_source,
      config_resolution_path: configResolutionPath,
    });

    const artifacts = [
      path.join(flashDir, 'flash_output.md'),
      path.join(flashDir, 'flash_output_meta.json'),
      path.join(flashDir, 'tool_calls.json'),
    ];

    return {
      status: 'ok',
      run_id: runId,
      runDir,
      flashDir,
      artifacts,
      warnings: resolved.resolution.warnings,
    };
  } catch (error) {
    return {
      status: 'error',
      run_id: resolvedRun?.runId,
      runDir: resolvedRun?.runDir,
      flashDir: resolvedRun?.runDir ? path.join(resolvedRun.runDir, 'flash') : undefined,
      error: toErrorEnvelope(error, resolvedRun?.runDir),
    };
  }
}

export async function runContextFinalize(opts: {
  runSelector: string;
  repoRoot: string;
}): Promise<ContextFinalizeCliResult> {
  let resolvedRun: { runId: string; runDir: string } | undefined;

  try {
    resolvedRun = resolveRunDir(opts.repoRoot, opts.runSelector);
    const { runId, runDir } = resolvedRun;

    if (!fs.existsSync(runDir)) {
      throw new LlmAdapterError(`run not found: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        path: runDir,
        details: [],
      });
    }

    const result = finalizeContext(runDir);
    return {
      status: 'ok',
      run_id: result.run_id,
      runDir,
      artifacts: result.artifacts,
      warnings: result.warnings,
      missing_skills: result.missing_skills,
    };
  } catch (error) {
    const fallbackPath = resolvedRun?.runDir ?? path.join(getWorkspacePaths(opts.repoRoot).runs, opts.runSelector);
    const diagnostic = error instanceof LlmAdapterError
      ? toErrorEnvelope(error, fallbackPath)
      : contextFinalizeErrorToDiagnostic(error, fallbackPath);
    return {
      status: 'error',
      run_id: resolvedRun?.runId,
      runDir: resolvedRun?.runDir,
      error: diagnostic,
    };
  }
}

export function createCli(): Command {
  const program = new Command();
  program.name('vibecode').description('VibecodeLight CLI');

  program
    .command('doctor')
    .description('Check local prerequisites and workspace status')
    .action(() => {
      const root = process.cwd();
      const paths = getWorkspacePaths(root);
      const configExists = fs.existsSync(paths.config);
      let configStatus = 'missing';
      if (configExists) {
        try {
          YAML.parse(fs.readFileSync(paths.config, 'utf8'));
          configStatus = 'ok';
        } catch {
          configStatus = 'invalid';
        }
      }
      const nodeStatus = process.versions.node;
      const pythonStatus = pythonAvailable() ? 'ok' : 'missing';
      console.log(`status: ok`);
      console.log(`node: ${nodeStatus}`);
      console.log(`config.yaml: ${configStatus}`);
      console.log(`python: ${pythonStatus}`);
    });

  program
    .command('init')
    .option('--repo <path>', 'Repository path', process.cwd())
    .description('Initialize the VibecodeLight workspace')
    .action(async (options: { repo: string }) => {
      const result = await initWorkspace(path.resolve(options.repo));
      console.log(JSON.stringify(result, null, 2));
    });

  const config = program.command('config').description('Inspect and sync global/local configuration');

  config
    .command('paths')
    .description('Show global and local configuration paths')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const paths = getConfigPaths(repoRoot, process.env);
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            global_dir: paths.globalDir,
            global_config: paths.globalConfig,
            global_env: paths.globalEnv,
            local_config: paths.localConfig,
          },
          artifacts: [],
          warnings: [],
        }));
        return;
      }
      console.log(`global_dir: ${paths.globalDir}`);
      console.log(`global_config: ${paths.globalConfig}`);
      console.log(`global_env: ${paths.globalEnv}`);
      console.log(`local_config: ${paths.localConfig}`);
    });

  config
    .command('show')
    .description('Show the resolved safe configuration and per-field source map (never prints API keys)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const resolved = resolveFlashConfig({ repoRoot, env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: resolved.resolution,
          artifacts: [],
          warnings: resolved.resolution.warnings,
        }));
        return;
      }
      const r = resolved.resolution;
      console.log(`selected_config_source: ${r.selected_config_source}`);
      console.log(`provider: ${r.provider ?? '(none)'} [${r.source_map.provider}]`);
      console.log(`model: ${r.model ?? '(none)'} [${r.source_map.model}]`);
      console.log(`baseUrl_host: ${r.baseUrl_host ?? '(none)'} [${r.source_map.baseUrl}]`);
      console.log(`api_key: ${r.has_api_key ? 'present' : 'missing'} [${r.source_map.apiKey}]`);
      console.log(`global_config: ${r.global_config_path} (${r.global_config_exists ? 'exists' : 'absent'})`);
      console.log(`global_env: ${r.global_env_path} (${r.global_env_exists ? 'exists' : 'absent'})`);
      console.log(`local_config: ${r.local_config_path} (${r.local_config_exists ? 'exists' : 'absent'})`);
      for (const warning of r.warnings) {
        console.log(`warning: ${warning}`);
      }
    });

  config
    .command('init-local')
    .description('Create the local workspace config from the global config (or safe defaults) if missing')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = ensureLocalConfig({ repoRoot, env: process.env });
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            local_config_path: result.localConfigPath,
            global_config_path: result.globalConfigPath,
            created: result.created,
            already_existed: result.alreadyExisted,
            created_from_global: result.createdFromGlobal,
            source: result.source,
          },
          artifacts: [result.localConfigPath],
          warnings: [],
        }));
        return;
      }
      console.log(`local_config: ${result.localConfigPath}`);
      console.log(`created: ${result.created}`);
      console.log(`created_from_global: ${result.createdFromGlobal}`);
      console.log(`source: ${result.source}`);
    });

  config
    .command('sync')
    .description('Explicitly sync config between global and local (requires a direction)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--from-global', 'Overwrite local config from global config')
    .option('--to-global', 'Overwrite global config from local config')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; fromGlobal?: boolean; toGlobal?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      if (Boolean(options.fromGlobal) === Boolean(options.toGlobal)) {
        const error = {
          code: 'SYNC_DIRECTION_REQUIRED',
          message: 'config sync requires exactly one direction: --from-global or --to-global',
          path: '',
          details: [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`config sync failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      const direction = options.fromGlobal ? 'from-global' : 'to-global';
      const result = syncConfig({ direction, repoRoot, env: process.env });
      if (!result.ok) {
        const error = {
          code: result.error?.code ?? 'CONFIG_SYNC_FAILED',
          message: result.error?.message ?? 'config sync failed',
          path: result.sourcePath,
          details: result.error?.details ?? [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`config sync failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            direction: result.direction,
            source: result.sourcePath,
            destination: result.destinationPath,
          },
          artifacts: [result.destinationPath],
          warnings: [],
        }));
        return;
      }
      console.log(`direction: ${result.direction}`);
      console.log(`source: ${result.sourcePath}`);
      console.log(`destination: ${result.destinationPath}`);
    });

  program
    .command('scan <task>')
    .description('Create a new run and scan the repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope to stdout')
    .action(async (task: string, options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await runScan({ task, repoRoot, jsonOutput: options.json });

      if (options.json) {
        if (result.status === 'error') {
          console.log(JSON.stringify({
            ok: false,
            error: {
              code: 'SCANNER_FAILED',
              message: result.diagnostic ?? 'scanner failed',
            },
          }));
          process.exitCode = 1;
        } else {
          const artifactPaths = result.artifacts
            ? Object.values(result.artifacts)
            : [];
          console.log(JSON.stringify({
            ok: true,
            data: {
              run_id: result.run_id,
              scan_dir: result.scanDir,
            },
            artifacts: artifactPaths,
            warnings: result.warnings ?? [],
          }));
        }
      } else if (result.status === 'error') {
        console.error(`scan failed: ${result.diagnostic}`);
        process.exitCode = 1;
      } else {
        console.log(`run: ${result.run_id}`);
        console.log(`scan: ${result.scanDir}`);
      }
    });

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

  const skills = program.command('skills').description('Manage VibecodeLight skills');

  skills
    .command('list')
    .description('List skills (user-profile and project SKILLS/)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const catalog = buildSkillsCatalog({ repoRoot });
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: { skills: catalog.skills },
            artifacts: [],
            warnings: catalog.warnings,
          }),
        );
        return;
      }
      if (catalog.skills.length === 0) {
        console.log('No skills found.');
      } else {
        for (const skill of catalog.skills) {
          console.log(`${skill.id}\t[${skill.source}/${skill.scope}]\t${skill.title}`);
        }
      }
      if (catalog.warnings.length > 0) {
        console.log('');
        console.log('Warnings:');
        for (const warning of catalog.warnings) {
          console.log(`  - ${warning}`);
        }
      }
    });

  skills
    .command('project-list')
    .description('List skills snapshotted in the project SKILLS/ directory')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const projectSkills = discoverProjectSkills(repoRoot);
      const warnings: string[] = [];
      for (const skill of projectSkills) {
        for (const w of skill.warnings) {
          warnings.push(`${skill.id}: ${w}`);
        }
      }
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: { skills: projectSkills },
            artifacts: [],
            warnings,
          }),
        );
        return;
      }
      if (projectSkills.length === 0) {
        console.log('No project skills found.');
      } else {
        for (const skill of projectSkills) {
          console.log(`${skill.id}\t${skill.title}`);
        }
      }
    });

  skills
    .command('copy [skillId]')
    .description('Copy a user-profile skill into the project SKILLS/ directory')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--all', 'Copy all user-profile skills')
    .option('--force', 'Overwrite existing destination')
    .option('--json', 'Output canonical JSON envelope')
    .action(
      (
        skillId: string | undefined,
        options: { repo: string; all?: boolean; force?: boolean; json?: boolean },
      ) => {
        const repoRoot = path.resolve(options.repo);

        if (options.all) {
          const result = copyAllSkills({ repoRoot, force: options.force });
          if (options.json) {
            console.log(
              JSON.stringify({
                ok: true,
                data: {
                  copied: result.copied,
                  skipped: result.skipped,
                  errors: result.errors,
                },
                artifacts: result.copied.map((id) =>
                  path.join(repoRoot, 'SKILLS', id, 'SKILL.md'),
                ),
                warnings: result.skipped.map(
                  (id) => `${id}: destination exists; pass --force to overwrite`,
                ),
              }),
            );
            return;
          }
          if (result.copied.length > 0) {
            console.log(`copied: ${result.copied.join(', ')}`);
          }
          if (result.skipped.length > 0) {
            console.log(`skipped (already exists): ${result.skipped.join(', ')}`);
          }
          for (const err of result.errors) {
            console.error(`error copying ${err.skillId}: ${err.error.message}`);
          }
          return;
        }

        if (!skillId) {
          const message = 'skill id is required when --all is not specified';
          if (options.json) {
            console.log(
              JSON.stringify({
                ok: false,
                error: { code: 'MISSING_SKILL_ID', message, details: [] },
              }),
            );
          } else {
            console.error(message);
          }
          process.exitCode = 1;
          return;
        }

        const result = copySkill({
          skillId,
          repoRoot,
          force: options.force,
        });
        if (!result.ok) {
          if (options.json) {
            console.log(
              JSON.stringify({
                ok: false,
                error: {
                  code: result.error?.code ?? 'UNKNOWN',
                  message: result.error?.message ?? 'copy failed',
                  path: result.error?.path,
                  details: [],
                },
              }),
            );
          } else {
            console.error(`copy failed: ${result.error?.message ?? 'unknown error'}`);
          }
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          console.log(
            JSON.stringify({
              ok: true,
              data: { skill_id: result.skillId, destination: result.destination },
              artifacts: result.destination ? [result.destination] : [],
              warnings: [],
            }),
          );
        } else {
          console.log(`copied ${result.skillId} -> ${result.destination}`);
        }
      },
    );

  const flash = program.command('flash').description('Flash output operations');

  flash
    .command('run <runId>')
    .description('Run the flash model for a saved flash input')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--mock', 'Use deterministic mock flash adapter')
    .option('--live', 'Allow live provider calls when configured')
    .option('--json', 'Output canonical JSON envelope')
    .action(async (runId: string, options: { repo: string; mock?: boolean; live?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await runFlash({
        runSelector: runId,
        repoRoot,
        mock: options.mock,
        live: options.live,
      });

      if (result.status === 'error') {
        const error = result.error ?? {
          code: 'FLASH_RUN_FAILED',
          message: 'flash run failed',
          path: result.flashDir,
          details: [],
        };
        if (options.json) {
          console.log(JSON.stringify({ ok: false, error }));
        } else {
          console.error(`flash run failed: ${error.message}`);
          if (error.path) {
            console.error(`path: ${error.path}`);
          }
        }
        process.exitCode = 1;
        return;
      }

      const artifacts = result.artifacts ?? [];
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            run_id: result.run_id,
            runDir: result.runDir,
            flash_dir: result.flashDir,
            flash_output: result.flashDir ? path.join(result.flashDir, 'flash_output.md') : undefined,
          },
          artifacts,
          warnings: result.warnings ?? [],
        }));
      } else {
        console.log(`run_id: ${result.run_id}`);
        console.log(`flashDir: ${result.flashDir}`);
        console.log('artifacts:');
        for (const artifact of artifacts) {
          console.log(`  ${artifact}`);
        }
      }
    });

  flash
    .command('validate <path>')
    .description('Validate a flash_output.md file against the contract')
    .option('--json', 'Output canonical JSON envelope')
    .action((filePath: string, options: { json?: boolean }) => {
      const resolvedPath = path.resolve(filePath);

      let result: ReturnType<typeof parseFlashOutput>;
      try {
        const markdown = fs.readFileSync(resolvedPath, 'utf8');
        result = parseFlashOutput(markdown, resolvedPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostic = {
          code: 'FLASH_OUTPUT_INVALID' as const,
          message: `unable to read flash output: ${message}`,
          path: resolvedPath,
          details: [message],
        };

        if (options.json) {
          console.log(JSON.stringify({ ok: false, error: diagnostic }));
        } else {
          console.log(`flash output invalid: ${resolvedPath}`);
          console.log(`  ${message}`);
        }
        process.exitCode = 1;
        return;
      }

      if (result.ok) {
        if (options.json) {
          console.log(
            JSON.stringify({
              ok: true,
              data: { sections: result.sections.map((section) => section.name) },
              artifacts: [],
              warnings: [],
            }),
          );
        } else {
          console.log(`flash output valid: ${resolvedPath}`);
          for (const section of result.sections) {
            console.log(`- ${section.name}`);
          }
        }
        return;
      }

      const diagnostic = result.diagnostic ?? {
        code: 'FLASH_OUTPUT_INVALID' as const,
        message: 'flash output invalid',
        path: resolvedPath,
        details: [],
      };

      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: diagnostic }));
      } else {
        console.log(`flash output invalid: ${resolvedPath}`);
        if (diagnostic.details.length > 0) {
          console.log('missing sections:');
          for (const detail of diagnostic.details) {
            console.log(`- ${detail}`);
          }
        } else {
          console.log(diagnostic.message);
        }
      }
      process.exitCode = 1;
    });

  const context = program.command('context').description('Context artifact operations');

  context
    .command('finalize <runId>')
    .description('Finalize context pack and selected skill artifacts for a flash output')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action(async (runId: string, options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await runContextFinalize({ runSelector: runId, repoRoot });

      if (result.status === 'error') {
        const error = result.error ?? {
          code: 'CONTEXT_FINALIZE_FAILED',
          message: 'context finalize failed',
          path: result.runDir,
          details: [],
        };
        if (options.json) {
          console.log(JSON.stringify({ ok: false, error }));
        } else {
          console.error(`context finalize failed: ${error.message}`);
          if (error.path) {
            console.error(`path: ${error.path}`);
          }
        }
        process.exitCode = 1;
        return;
      }

      const artifacts = result.artifacts ?? [];
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            run_id: result.run_id,
            runDir: result.runDir,
            missing_skills: result.missing_skills ?? [],
          },
          artifacts,
          warnings: result.warnings ?? [],
        }));
      } else {
        console.log(`run_id: ${result.run_id}`);
        console.log(`runDir: ${result.runDir}`);
        console.log('artifacts:');
        for (const artifact of artifacts) {
          console.log(`  ${artifact}`);
        }
        if ((result.warnings ?? []).length > 0) {
          console.log('warnings:');
          for (const warning of result.warnings ?? []) {
            console.log(`  ${warning}`);
          }
        }
      }
    });

  // context-build command
  program
    .command('context-build <task>')
    .description('create a run, scan the repo, and build flash input artifacts')
    .option('--repo <path>', 'repository root (default: cwd)', process.cwd())
    .option('--json', 'output canonical JSON envelope')
    .action(async (task: string, options: { repo?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo ?? process.cwd());
      const result = await runContextBuild({ task, repoRoot, jsonOutput: options.json });

      if (result.status === 'error') {
        if (options.json) {
          console.log(
            JSON.stringify({
              ok: false,
              error: {
                code: result.error?.code ?? 'UNKNOWN',
                message: result.error?.message ?? 'context-build failed',
                path: result.error?.path,
                details: result.error?.details ?? [],
              },
            }),
          );
        } else {
          console.error(`context-build failed: ${result.error?.message ?? 'unknown error'}`);
        }
        process.exitCode = 1;
        return;
      }

      const artifactPaths: string[] = result.artifacts ?? [];
      if (options.json) {
        console.log(
          JSON.stringify({
            ok: true,
            data: {
              run_id: result.run_id,
              runDir: result.runDir,
              flash_dir: result.runDir ? path.join(result.runDir, 'flash') : undefined,
            },
            artifacts: artifactPaths,
            warnings: result.warnings ?? [],
          }),
        );
      } else {
        console.log(`run_id: ${result.run_id}`);
        console.log(`runDir: ${result.runDir}`);
        if (artifactPaths.length > 0) {
          console.log('artifacts:');
          for (const p of artifactPaths) {
            console.log(`  ${p}`);
          }
        }
        if ((result.warnings ?? []).length > 0) {
          console.log('warnings:');
          for (const w of result.warnings ?? []) {
            console.log(`  ${w}`);
          }
        }
      }
    });

  const handlePromptRender = (runId: string | undefined, options: { repo: string; json?: boolean }): void => {
    if (!runId) {
      const error = { code: 'RUN_ID_REQUIRED', message: 'run id is required', path: '', details: [] };
      if (options.json) console.log(JSON.stringify({ ok: false, error }));
      else console.error(`prompt render failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    const repoRoot = path.resolve(options.repo);
    const paths = getWorkspacePaths(repoRoot);

    let resolvedRun: { runId: string; runDir: string } | undefined;
    try {
      resolvedRun = resolveRunDir(repoRoot, runId);
    } catch (err) {
      const error = {
        code: 'RUN_NOT_FOUND',
        message: err instanceof Error ? err.message : String(err),
        path: path.join(paths.runs, runId),
        details: [],
      };
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error }));
      } else {
        console.error(`prompt render failed: ${error.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const { runDir } = resolvedRun;
    if (!fs.existsSync(runDir)) {
      const error = {
        code: 'RUN_NOT_FOUND',
        message: `run not found: ${resolvedRun.runId}`,
        path: runDir,
        details: [],
      };
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error }));
      } else {
        console.error(`prompt render failed: ${error.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const result = renderFinalPrompt(runDir, { vibecodePath: paths.vibecode });

    if (!result.ok) {
      const error = result.error ?? {
        code: 'PROMPT_RENDER_FAILED',
        message: 'prompt render failed',
        details: [],
      };
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error }));
      } else {
        console.error(`prompt render failed: ${error.message}`);
        if (error.path) console.error(`path: ${error.path}`);
      }
      process.exitCode = 1;
      return;
    }

    const artifacts = result.artifacts ?? [];
    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        data: {
          run_id: result.runId,
          runDir,
          final_prompt: path.join(runDir, 'output', 'final_prompt.md'),
        },
        artifacts,
        warnings: result.warnings ?? [],
      }));
    } else {
      console.log(`run_id: ${result.runId}`);
      console.log(`runDir: ${runDir}`);
      console.log('artifacts:');
      for (const artifact of artifacts) {
        console.log(`  ${artifact}`);
      }
      if ((result.warnings ?? []).length > 0) {
        console.log('warnings:');
        for (const warning of result.warnings ?? []) {
          console.log(`  ${warning}`);
        }
      }
    }
  };

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
    .action((runId: string, options: { repo: string; json?: boolean }) => {
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

      const info = getRunInfo(resolvedRun.runDir);
      const artifacts = Object.values(info.artifacts).filter((value): value is string => typeof value === 'string');

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: info,
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
      console.log('artifacts:');
      const artifactLines: Array<[string, string | undefined]> = [
        ['user_prompt.md', info.artifacts.user_prompt],
        ['run_manifest.json', info.artifacts.run_manifest],
        ['scanner_config.json', info.artifacts.scanner_config],
        ['flash/flash_input.md', info.artifacts.flash_input],
        ['flash/flash_output.md', info.artifacts.flash_output],
        ['output/context_pack.md', info.artifacts.context_pack],
        ['skills/selected_skills.json', info.artifacts.selected_skills],
        ['output/final_prompt.md', info.artifacts.final_prompt],
      ];
      for (const [label, artifactPath] of artifactLines) {
        console.log(`  ${label}: ${artifactPath ? 'exists' : 'missing'}`);
      }
    });

  const prompt = program
    .command('prompt')
    .description('Run full prompt pipeline: scan → flash → context → render')
    .argument('[args...]', 'Task prompt, or render <runId>')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--mock', 'Use mock flash adapter (required for this checkpoint)')
    .option('--json', 'Output canonical JSON envelope')
    .action(async (args: string[] | undefined, options: { repo: string; mock?: boolean; json?: boolean }) => {
      const parts = args ?? [];
      if (parts[0] === 'render') {
        handlePromptRender(parts[1], options);
        return;
      }

      const task = parts.join(' ').trim();
      if (!task) {
        const error = { code: 'TASK_REQUIRED', message: 'task is required', path: '', details: [] };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(error.message);
        process.exitCode = 1;
        return;
      }

      const repoRoot = path.resolve(options.repo);
      const result = await runPromptPipeline({
        task,
        repoRoot,
        mock: options.mock === true,
      });

      if (result.ok === false) {
        const error = {
          code: result.error.code,
          message: result.error.message,
          path: result.error.path ?? '',
          details: result.error.details,
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`prompt failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            run_id: result.run_id,
            runDir: result.runDir,
            finalPromptPath: result.finalPromptPath,
          },
          artifacts: result.artifacts,
          warnings: result.warnings,
        }));
        return;
      }

      console.log(`run: ${result.run_id}`);
      console.log(`runDir: ${result.runDir}`);
      console.log(`final_prompt: ${result.finalPromptPath}`);
      console.log('artifacts:');
      for (const artifact of result.artifacts) {
        console.log(`  ${artifact}`);
      }
      console.log('note: no terminal send in this checkpoint');
    });

  prompt
    .command('render <runId>')
    .description('Render final_prompt.md from a finalized run')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((runId: string, options: { repo: string; json?: boolean }) => {
      handlePromptRender(runId, { repo: options.repo, json: options.json ?? prompt.opts<{ json?: boolean }>().json });
    });

  const desktopCmd = program.command('desktop').description('Desktop shell commands');

  desktopCmd
    .command('smoke')
    .description('Headless smoke test of the desktop terminal bridge (no Electron window)')
    .option('--repo <path>', 'Working directory for terminal session', process.cwd())
    .option('--marker <text>', 'Marker string to wait for', 'VIBECODE_ELECTRON_PTY_OK')
    .option('--timeout <ms>', 'Timeout in milliseconds', '15000')
    .option('--json', 'Output JSON envelope')
    .action(async (options: { repo: string; marker: string; timeout: string; json?: boolean }) => {
      const result = await runDesktopSmoke({
        repo: options.repo,
        marker: options.marker,
        timeoutMs: Number(options.timeout),
      });

      if (options.json) {
        if (result.ok) {
          console.log(JSON.stringify({
            ok: true,
            data: {
              marker: result.marker,
              marker_seen: result.marker_seen,
              pid: result.pid,
              shell: result.shell,
              cwd: result.cwd,
            },
            artifacts: [],
            warnings: [],
          }));
        } else {
          console.log(JSON.stringify({
            ok: false,
            error: result.error ?? { code: 'DESKTOP_SMOKE_FAILED', message: 'desktop smoke failed' },
          }));
        }
      } else if (result.ok) {
        console.log('desktop smoke: ok');
        console.log(`marker: ${result.marker}`);
        console.log(`shell: ${result.shell}`);
        console.log(`pid: ${result.pid}`);
        console.log(`cwd: ${result.cwd}`);
      } else {
        console.error(`desktop smoke failed: ${result.error?.message ?? 'marker not seen'}`);
        if (result.error?.code) {
          console.error(`code: ${result.error.code}`);
        }
      }
      process.exitCode = result.ok ? 0 : 1;
    });

  const terminalCmd = program.command('terminal').description('Terminal commands');

  terminalCmd
    .command('demo')
    .description('Start a real PTY terminal demo')
    .option('--repo <path>', 'Working directory for terminal session', process.cwd())
    .option('--command <cmd>', 'Command to run in terminal')
    .option('--json', 'Output JSON envelope')
    .action(async (options: { repo: string; command?: string; json?: boolean }) => {
      const result = await runTerminalDemo({
        repo: options.repo,
        command: options.command,
        json: options.json,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.ok) {
        console.log('terminal demo: ok');
        console.log(`shell: ${result.shell}`);
        console.log(`pid: ${result.pid}`);
        console.log(`cwd: ${result.cwd}`);
        if ((result.artifacts ?? []).length > 0) {
          console.log('artifacts:');
          for (const artifact of result.artifacts ?? []) {
            console.log(`  ${artifact}`);
          }
        }
        if ((result.warnings ?? []).length > 0) {
          console.log('warnings:');
          for (const warning of result.warnings ?? []) {
            console.log(`  ${warning}`);
          }
        }
        if (result.excerpt) {
          console.log('excerpt:');
          console.log(result.excerpt);
        }
      } else {
        console.error(`terminal demo failed: ${result.error?.message ?? 'unknown error'}`);
        if (result.error?.code) {
          console.error(`code: ${result.error.code}`);
        }
      }
      process.exitCode = result.ok ? 0 : 1;
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createCli();
  await program.parseAsync(argv);
}

if (require.main === module) {
  void runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
