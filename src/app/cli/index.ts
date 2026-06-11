import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import {
  type CodeGraphContextMode,
  type CodeGraphContextRunner,
  type CodeGraphReadinessProvider,
} from '../../adapters/codegraph/codegraph_context.js';
import {
  type CodeGraphMcpContextRunner,
} from '../../adapters/codegraph/codegraph_mcp.js';
import {
  type CodeGraphTransport,
} from '../../adapters/codegraph/codegraph_transport.js';
import { LlmAdapterError } from '../../adapters/llm/errors.js';
import {
  performContextBuildPhase,
  type ContextBuildPhaseResult,
} from '../../core/runs/context_build_phase.js';
import {
  performContextFinalizePhase,
  type ContextFinalizePhaseResult,
} from '../../core/runs/context_finalize_phase.js';
import {
  performFlashPhase,
  type FlashPhaseResult,
} from '../../core/runs/flash_phase.js';
import {
  performPromptCommandPhase,
  BAD_PROVIDER_RESPONSE_TIP,
  type PromptCommandPhaseOptions,
  type PromptSendTerminal,
} from '../../core/runs/prompt_command_phase.js';
import { updateCurrent } from '../../core/runs/current.js';
import { performScanPhase, writeRunManifest } from '../../core/runs/scan_phase.js';
import { getWorkspacePaths } from '../../core/workspace/paths.js';
import { RunManifest } from '../../core/models/index.js';
import {
  contextFinalizeErrorToDiagnostic,
  parseFlashOutput,
} from '../../core/context/index.js';
import { renderFinalPrompt } from '../../core/prompting/index.js';
import type { PromptPipelineResult } from '../../core/prompting/index.js';
import {
  resolveAgentBindingInput,
  writeAgentBinding,
} from '../../core/coordination/agent_binding.js';
import { runTerminalDemo } from '../../core/terminal/index.js';
import { runDesktopSmoke } from '../desktop/desktop_smoke.js';
import { registerAgentGuidanceCommands } from './commands/agent_guidance.js';
import { registerAgentsCommands } from './commands/agents.js';
import { registerClaimsCommands } from './commands/claims.js';
import { registerCommitCommands } from './commands/commit.js';
import { registerConflictsCommands } from './commands/conflicts.js';
import { registerCodeGraphCommands } from './commands/codegraph.js';
import { registerConfigCommands } from './commands/config.js';
import { registerCoordinationCommands } from './commands/coordination.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEvidenceCommands } from './commands/evidence.js';
import { registerFinalizeCommands } from './commands/finalize.js';
import { registerGitChangesCommands } from './commands/git_changes.js';
import { registerHandoffCommands } from './commands/handoff.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerScanReadCommands } from './commands/scan.js';
import { registerSessionCommands } from './commands/session.js';
import { registerToolsCommands } from './commands/tools.js';
import { registerRunCreateCommand, registerRunsCommands, resolveRunDir } from './commands/runs.js';
import { registerSkillsCommands } from './commands/skills.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import {
  emitCliStructuredError,
  makeCliStructuredError,
  type CliStructuredError,
} from './structured_output.js';

export { BAD_PROVIDER_RESPONSE_TIP };
export type { PromptSendTerminal };
export type PromptCommandOptions = PromptCommandPhaseOptions;

const BUNDLED_FLASH_SYSTEM_PROMPT_PATH = path.resolve(__dirname, '../../../resources/prompts/flash_system.md');

export async function runPromptCommand(options: PromptCommandOptions): Promise<PromptPipelineResult> {
  return performPromptCommandPhase(options);
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

export type ContextBuildResult = ContextBuildPhaseResult;

export type FlashRunResult = FlashPhaseResult;

export type ContextFinalizeCliResult = ContextFinalizePhaseResult;

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

function parseCodeGraphModeOption(mode: string | undefined):
  | { ok: true; mode?: CodeGraphContextMode }
  | { ok: false; error: CliStructuredError } {
  const normalized = mode?.trim();
  if (!normalized) return { ok: true, mode: undefined };
  if (normalized === 'detect-only' || normalized === 'use-existing') {
    return { ok: true, mode: normalized };
  }
  return {
    ok: false,
    error: makeCliStructuredError(
      'INVALID_CODEGRAPH_MODE',
      `invalid --codegraph-mode: ${normalized}`,
      '',
      ['Expected one of: detect-only, use-existing.'],
    ),
  };
}

function resolvePromptCodeGraphMode(options: {
  codegraph?: boolean;
  codegraphMode?: string;
}):
  | { ok: true; mode?: CodeGraphContextMode }
  | { ok: false; error: CliStructuredError } {
  const parsed = parseCodeGraphModeOption(options.codegraphMode);
  if (!parsed.ok) return parsed;

  if (options.codegraph === true && parsed.mode === 'detect-only') {
    return {
      ok: false,
      error: makeCliStructuredError(
        'CONFLICTING_CODEGRAPH_FLAGS',
        '--codegraph conflicts with --codegraph-mode detect-only. Use one CodeGraph mode selector.',
        '',
        ['--codegraph selects use-existing.', '--codegraph-mode detect-only disables CodeGraph context injection.'],
      ),
    };
  }

  if (options.codegraph === false && parsed.mode === 'use-existing') {
    return {
      ok: false,
      error: makeCliStructuredError(
        'CONFLICTING_CODEGRAPH_FLAGS',
        '--no-codegraph conflicts with --codegraph-mode use-existing. Use one CodeGraph mode selector.',
        '',
        ['--no-codegraph selects detect-only.', '--codegraph-mode use-existing enables CodeGraph context injection.'],
      ),
    };
  }

  if (options.codegraph === true) return { ok: true, mode: 'use-existing' };
  if (options.codegraph === false) return { ok: true, mode: 'detect-only' };
  return { ok: true, mode: parsed.mode };
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
  codegraphMode?: CodeGraphContextMode;
  /** Phase 1B transport selection. CLI defaults to cli; tests may pass mcp/auto. */
  codegraphTransport?: CodeGraphTransport;
  taskNormalizerEnabled?: boolean;
  /** Test seam for pipeline-level CodeGraph behavior; CLI never sets this. */
  codegraphRunner?: CodeGraphContextRunner;
  /** Test seam for pipeline-level CodeGraph behavior; CLI never sets this. */
  codegraphReadinessProvider?: CodeGraphReadinessProvider;
  /** Test seam for pipeline-level CodeGraph behavior; CLI never sets this. */
  codegraphCommand?: string;
  /** Test seam for the MCP transport; CLI never sets this. */
  codegraphMcpRunner?: CodeGraphMcpContextRunner;
  /** UI-selected repo-local skill ids; written to skills/manifest.json. */
  selectedSkillIds?: readonly string[];
}): Promise<ContextBuildResult> {
  return performContextBuildPhase({
    task: opts.task,
    repoRoot: opts.repoRoot,
    codegraphMode: opts.codegraphMode,
    codegraphTransport: opts.codegraphTransport,
    taskNormalizerEnabled: opts.taskNormalizerEnabled,
    codegraphRunner: opts.codegraphRunner,
    codegraphReadinessProvider: opts.codegraphReadinessProvider,
    codegraphCommand: opts.codegraphCommand,
    codegraphMcpRunner: opts.codegraphMcpRunner,
    selectedSkillIds: opts.selectedSkillIds,
  });
}

export async function runFlash(opts: {
  runSelector: string;
  repoRoot: string;
  mock?: boolean;
  live?: boolean;
  flashProvider?: string;
  flashModel?: string;
}): Promise<FlashRunResult> {
  let resolvedRun: { runId: string; runDir: string };
  try {
    resolvedRun = resolveRunDir(opts.repoRoot, opts.runSelector);
  } catch (error) {
    return {
      status: 'error',
      error: toErrorEnvelope(error),
    };
  }

  return performFlashPhase({
    runId: resolvedRun.runId,
    runDir: resolvedRun.runDir,
    repoRoot: opts.repoRoot,
    mock: opts.mock,
    live: opts.live,
    flashProvider: opts.flashProvider,
    flashModel: opts.flashModel,
    bundledFlashSystemPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
  });
}

export async function runContextFinalize(opts: {
  runSelector: string;
  repoRoot: string;
  selectedSkillIds?: readonly string[];
}): Promise<ContextFinalizeCliResult> {
  let resolvedRun: { runId: string; runDir: string };
  try {
    resolvedRun = resolveRunDir(opts.repoRoot, opts.runSelector);
  } catch (error) {
    const fallbackPath = path.join(getWorkspacePaths(opts.repoRoot).runs, opts.runSelector);
    const diagnostic = error instanceof LlmAdapterError
      ? toErrorEnvelope(error, fallbackPath)
      : contextFinalizeErrorToDiagnostic(error, fallbackPath);
    return {
      status: 'error',
      error: diagnostic,
    };
  }

  return performContextFinalizePhase({
    runId: resolvedRun.runId,
    runDir: resolvedRun.runDir,
    repoRoot: opts.repoRoot,
    selectedSkillIds: opts.selectedSkillIds,
  });
}


export function createCli(): Command {
  const program = new Command();
  program.name('vibecode').description('VibecodeLight CLI');
  // Scope options to the command they follow. Required so the `scan` command can
  // carry both a positional <task> (legacy `vibecode scan "task"`) and the
  // Phase 1B-2 `scan summary` / `scan artifact-read` subcommands that redeclare
  // --repo/--json without the parent greedily consuming those options.
  program.enablePositionalOptions();

  registerDoctorCommand(program);
  registerWorkspaceCommands(program);

  registerConfigCommands(program);
  registerCoordinationCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerSessionCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerHandoffCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerToolsCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerGitChangesCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerAgentsCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerClaimsCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerConflictsCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerFinalizeCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerEvidenceCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerCommitCommands(program, { makeCliStructuredError, emitCliStructuredError });
  registerAgentGuidanceCommands(program, { makeCliStructuredError, emitCliStructuredError });

  const scanCommand = program
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

  // Phase 1B-2: read-only `scan summary` / `scan artifact-read` subcommands.
  // These attach to the same `scan` command above; Commander routes the
  // subcommand names ahead of the positional <task> argument.
  registerScanReadCommands(scanCommand, { makeCliStructuredError, emitCliStructuredError });

  registerRunCreateCommand(program);

  registerSkillsCommands(program);

  const flash = program.command('flash').description('Flash output operations');

  flash
    .command('run <runId>')
    .description('Run the flash model for a saved flash input')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--mock', 'Use deterministic mock flash adapter')
    .option('--live', 'Allow live provider calls when configured')
    .option('--flash-provider <id>', 'Override the active flash provider id')
    .option('--flash-model <id>', 'Override the active flash model id')
    .option('--json', 'Output canonical JSON envelope')
    .action(async (runId: string, options: { repo: string; mock?: boolean; live?: boolean; flashProvider?: string; flashModel?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await runFlash({
        runSelector: runId,
        repoRoot,
        mock: options.mock,
        live: options.live,
        flashProvider: options.flashProvider,
        flashModel: options.flashModel,
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
    .option('--skill <id>', 'Include a UI-selected skill id (repeatable)', (value: string, prev: string[] = []) => prev.concat([value]), [] as string[])
    .option('--json', 'Output canonical JSON envelope')
    .action(async (runId: string, options: { repo: string; skill?: string[]; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await runContextFinalize({ runSelector: runId, repoRoot, selectedSkillIds: options.skill ?? [] });

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


  registerCodeGraphCommands(program, { makeCliStructuredError, emitCliStructuredError });

  registerMcpCommands(program, { makeCliStructuredError, emitCliStructuredError });

  // context-build command
  program
    .command('context-build <task>')
    .description('create a run, scan the repo, and build flash input artifacts')
    .option('--repo <path>', 'repository root (default: cwd)', process.cwd())
    .option('--codegraph-mode <mode>', 'CodeGraph context mode: detect-only | use-existing')
    .option('--task-normalizer', 'Enable Task Normalizer')
    .option('--no-task-normalizer', 'Disable Task Normalizer (default)', false)
    .option('--skill <id>', 'Include a UI-selected skill id (repeatable)', (value: string, prev: string[] = []) => prev.concat([value]), [] as string[])
    .option('--json', 'output canonical JSON envelope')
    .action(async (task: string, options: { repo?: string; codegraphMode?: string; taskNormalizer?: boolean; skill?: string[]; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo ?? process.cwd());
      const parsedMode = parseCodeGraphModeOption(options.codegraphMode);
      if (parsedMode.ok === false) {
        emitCliStructuredError(parsedMode.error, { json: options.json, prefix: 'context-build failed' });
        return;
      }
      const result = await runContextBuild({
        task,
        repoRoot,
        jsonOutput: options.json,
        codegraphMode: parsedMode.mode,
        taskNormalizerEnabled: options.taskNormalizer === true,
        selectedSkillIds: options.skill ?? [],
      });

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

  const handlePromptRender = (
    runId: string | undefined,
    options: { repo: string; json?: boolean; agent?: string; terminalSession?: string; agentMode?: string },
  ): void => {
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

    // Phase 3B: optional run/agent binding + coordination block. Validate the
    // requested agent against live coordination state before rendering; on
    // failure emit a structured error and do not render.
    const bindingResult = resolveAgentBindingInput(repoRoot, {
      agentId: options.agent,
      terminalSessionId: options.terminalSession,
      agentMode: options.agentMode,
    });
    if (!bindingResult.ok) {
      emitCliStructuredError(
        makeCliStructuredError(
          bindingResult.error.code,
          bindingResult.error.message,
          repoRoot,
          bindingResult.error.details,
        ),
        { json: options.json, prefix: 'prompt render failed' },
      );
      return;
    }
    if (bindingResult.binding) {
      writeAgentBinding(runDir, bindingResult.binding);
    }

    const result = renderFinalPrompt(runDir, { vibecodePath: paths.vibecode, repoRoot });

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


  registerRunsCommands(program);

  const prompt = program
    .command('prompt')
    .description('Run full prompt pipeline: scan → flash → context → render')
    .argument('[args...]', 'Task prompt, or render <runId>')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--mock', 'Use mock flash adapter (deterministic, no provider call)')
    .option('--live', 'Use configured live flash provider')
    .option('--flash-provider <id>', 'Override the active flash provider id')
    .option('--flash-model <id>', 'Override the active flash model id')
    .option('--codegraph', 'Use existing CodeGraph index during context build (use-existing mode)')
    .option('--no-codegraph', 'Skip CodeGraph context injection (detect-only mode)')
    .option('--codegraph-mode <mode>', 'Explicit CodeGraph mode: detect-only | use-existing')
    .option('--task-normalizer', 'Enable Task Normalizer (translate/expand task into English hints before context selection)')
    .option('--no-task-normalizer', 'Disable Task Normalizer (default)', false)
    .option('--auto-approve', 'Send the rendered final_prompt.md into a terminal without a separate approval step')
    .option('--skill <id>', 'Include a UI-selected skill id (repeatable)', (value: string, prev: string[] = []) => prev.concat([value]), [] as string[])
    .option('--agent <agent_id>', 'Bind the run to a coordinating agent id (renders a coordination block)')
    .option('--terminal-session <id>', 'Owning terminal session id to record in the run/agent binding')
    .option('--agent-mode <mode>', 'Agent tooling capability: mcp | cli | unknown')
    .option('--json', 'Output canonical JSON envelope')
    .action(async (args: string[] | undefined, options: { repo: string; mock?: boolean; live?: boolean; flashProvider?: string; flashModel?: string; codegraph?: boolean; codegraphMode?: string; taskNormalizer?: boolean; autoApprove?: boolean; skill?: string[]; agent?: string; terminalSession?: string; agentMode?: string; json?: boolean }) => {
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

      const resolvedCodegraph = resolvePromptCodeGraphMode({ codegraph: options.codegraph, codegraphMode: options.codegraphMode });
      if (resolvedCodegraph.ok === false) {
        emitCliStructuredError(resolvedCodegraph.error, { json: options.json, prefix: 'prompt failed' });
        return;
      }

      const repoRoot = path.resolve(options.repo);

      // Phase 3B: resolve + validate optional run/agent binding before the run.
      const bindingResult = resolveAgentBindingInput(repoRoot, {
        agentId: options.agent,
        terminalSessionId: options.terminalSession,
        agentMode: options.agentMode,
      });
      if (!bindingResult.ok) {
        emitCliStructuredError(
          makeCliStructuredError(
            bindingResult.error.code,
            bindingResult.error.message,
            repoRoot,
            bindingResult.error.details,
          ),
          { json: options.json, prefix: 'prompt failed' },
        );
        return;
      }

      const result = await runPromptCommand({
        task,
        repoRoot,
        mock: options.mock === true,
        live: options.live === true,
        flashProvider: options.flashProvider,
        flashModel: options.flashModel,
        codegraphMode: resolvedCodegraph.mode,
        taskNormalizerEnabled: options.taskNormalizer === true,
        autoApprove: options.autoApprove === true,
        selectedSkillIds: options.skill ?? [],
        agentBinding: bindingResult.binding,
        json: options.json,
      });
      if (result.ok === false) process.exitCode = 1;
    });

  prompt
    .command('render <runId>')
    .description('Render final_prompt.md from a finalized run')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--agent <agent_id>', 'Bind the run to a coordinating agent id (renders a coordination block)')
    .option('--terminal-session <id>', 'Owning terminal session id to record in the run/agent binding')
    .option('--agent-mode <mode>', 'Agent tooling capability: mcp | cli | unknown')
    .option('--json', 'Output canonical JSON envelope')
    .action((runId: string, options: { repo: string; json?: boolean; agent?: string; terminalSession?: string; agentMode?: string }) => {
      // Agent/coordination flags may be parsed against the parent `prompt`
      // command depending on their position, so fall back to its opts (as the
      // existing --json handling does).
      const parentOpts = prompt.opts<{ json?: boolean; agent?: string; terminalSession?: string; agentMode?: string }>();
      handlePromptRender(runId, {
        repo: options.repo,
        json: options.json ?? parentOpts.json,
        agent: options.agent ?? parentOpts.agent,
        terminalSession: options.terminalSession ?? parentOpts.terminalSession,
        agentMode: options.agentMode ?? parentOpts.agentMode,
      });
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
