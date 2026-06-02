import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import {
  buildCodeGraphContext,
  writeCodeGraphContextArtifacts,
  type CodeGraphContextMode,
  type CodeGraphContextResult,
  type CodeGraphContextRunner,
  type CodeGraphReadinessProvider,
} from '../../adapters/codegraph/codegraph_context.js';
import {
  type CodeGraphMcpContextRunner,
} from '../../adapters/codegraph/codegraph_mcp.js';
import {
  DEFAULT_CODEGRAPH_TRANSPORT,
  type CodeGraphTransport,
} from '../../adapters/codegraph/codegraph_transport.js';
import type { LlmAdapter } from '../../adapters/llm/base.js';
import { LlmAdapterError, ProviderNotConfiguredError } from '../../adapters/llm/errors.js';
import { MockFlashAdapter } from '../../adapters/llm/mock_flash.js';
import { OpenAiCompatibleAdapter } from '../../adapters/llm/openai_compatible_adapter.js';
import {
  ensureLocalConfig,
  readCodeGraphTransportSetting,
  resolveFlashConfig,
  writeConfigResolution,
} from '../../core/config/index.js';
import { updateCurrent } from '../../core/runs/current.js';
import { performScanPhase, writeRunManifest } from '../../core/runs/scan_phase.js';
import { getWorkspacePaths } from '../../core/workspace/paths.js';
import { RunManifest } from '../../core/models/index.js';
import { augmentExternalToolsWithCodeGraphContext } from '../../core/scanning/external_tools.js';
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
import { resolveFlashSystemPrompt, writeFlashSystemPromptArtifacts } from '../../core/prompts/flash_system_prompt.js';
import { buildCodeGraphTask } from '../../core/prompting/codegraph_task.js';
import { renderFinalPrompt, runPromptPipeline } from '../../core/prompting/index.js';
import type { PipelineEvent, PromptPipelineResult } from '../../core/prompting/index.js';
import {
  closeSession,
  runTerminalDemo,
  sendFinalPrompt,
  startTerminalSession,
  type SendPromptError,
  type SendPromptSuccess,
  type TerminalSendWriter,
} from '../../core/terminal/index.js';
import { runDesktopSmoke } from '../desktop/desktop_smoke.js';
import { runTaskNormalizer, writeTaskIntentArtifacts } from '../../adapters/task_normalizer/index.js';
import { registerCodeGraphCommands } from './commands/codegraph.js';
import { registerConfigCommands } from './commands/config.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerRunCreateCommand, registerRunsCommands, resolveRunDir } from './commands/runs.js';
import { registerSkillsCommands } from './commands/skills.js';
import { registerWorkspaceCommands } from './commands/workspace.js';

export const BAD_PROVIDER_RESPONSE_TIP = 'Tip: This indicates an API endpoint, auth, model, or provider configuration error. Check pnpm vibecode config show for your current provider configuration.';

const BUNDLED_FLASH_SYSTEM_PROMPT_PATH = path.resolve(__dirname, '../../../resources/prompts/flash_system.md');

type TextWriter = { write(chunk: string): unknown };

export function formatPromptProgressEvent(event: PipelineEvent): string | undefined {
  const messages: Partial<Record<PipelineEvent['phase'], string>> = {
    scan_started: 'Scanning repository...',
    scan_completed: 'Repository scanned',
    flash_input_built: 'Flash input built',
    flash_request_started: 'Calling flash provider...',
    flash_response_received: 'Flash response received',
    flash_output_validated: 'Flash output validated',
    context_pack_written: 'Context pack written',
    final_prompt_written: 'Final prompt rendered',
  };

  if (event.phase === 'provider_resolved') {
    const provider = event.provider_id ?? 'unknown';
    const modelSuffix = event.model_id ? ` / ${event.model_id}` : '';
    return `[vibecode] ${event.phase}: Using provider ${provider}${modelSuffix}`;
  }

  const message = messages[event.phase];
  if (!message) return undefined;
  return `[vibecode] ${event.phase}: ${message}`;
}

export function writePromptProgressEvent(event: PipelineEvent, stderr: TextWriter = process.stderr): void {
  const line = formatPromptProgressEvent(event);
  if (line) stderr.write(`${line}\n`);
}

/**
 * A terminal target for an auto-approved send. The CLI spawns a real PTY by
 * default; tests inject a fake writer so the auto-approve path stays
 * deterministic and never starts a shell.
 */
export interface PromptSendTerminal {
  writer: TerminalSendWriter;
  close?: () => void | Promise<void>;
}

export interface PromptCommandOptions {
  task: string;
  repoRoot: string;
  mock: boolean;
  live?: boolean;
  flashProvider?: string;
  flashModel?: string;
  codegraphMode?: CodeGraphContextMode;
  /** Test seam/settings override: public CLI uses persisted settings instead of a prompt flag. */
  codegraphTransport?: CodeGraphTransport;
  /** Test seam: inject an MCP runner without spawning a real server. */
  codegraphMcpRunner?: CodeGraphMcpContextRunner;
  taskNormalizerEnabled?: boolean;
  json?: boolean;
  stdout?: TextWriter;
  stderr?: TextWriter;
  adapter?: LlmAdapter;
  /**
   * When true, the rendered final_prompt.md is sent into a terminal without a
   * separate approval step and send_metadata.json records auto_approve=true.
   */
  autoApprove?: boolean;
  /** Test seam: provide the send target instead of spawning a real PTY. */
  sendTerminal?: PromptSendTerminal;
}

function createCliSendTerminal(repoRoot: string): PromptSendTerminal {
  const session = startTerminalSession({ cwd: repoRoot, cols: 120, rows: 30 });
  const writer: TerminalSendWriter = {
    sessionId: `cli-${session.metadata.pid}`,
    cwd: session.metadata.cwd,
    write: (data: string) => session.pty.write(data),
  };
  return {
    writer,
    close: () => closeSession(session),
  };
}

export async function runPromptCommand(options: PromptCommandOptions): Promise<PromptPipelineResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const codegraphTransport = options.codegraphTransport ?? readCodeGraphTransportSetting({ env: process.env }).transport;
  const result = await runPromptPipeline({
    task: options.task,
    repoRoot: options.repoRoot,
    mock: options.mock,
    live: options.live,
    flashProvider: options.flashProvider,
    flashModel: options.flashModel,
    codegraphMode: options.codegraphMode,
    codegraphTransport,
    ...(options.codegraphMcpRunner ? { codegraphMcpRunner: options.codegraphMcpRunner } : {}),
    taskNormalizerEnabled: options.taskNormalizerEnabled === true,
    adapter: options.adapter,
    onProgress: options.json ? undefined : (event) => writePromptProgressEvent(event, stderr),
  });

  if (result.ok === false) {
    const error = {
      code: result.error.code,
      message: result.error.message,
      path: result.error.path ?? '',
      details: result.error.details,
      ...(result.error.artifacts ? { artifacts: result.error.artifacts } : {}),
    };
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    } else {
      stderr.write(`prompt failed: ${error.message}\n`);
      if (error.code === 'FLASH_PROVIDER_BAD_RESPONSE') stderr.write(`${BAD_PROVIDER_RESPONSE_TIP}\n`);
    }
    return result;
  }

  // Auto-approve: skip the separate approval step and send the saved
  // final_prompt.md straight into a terminal. The artifact is the truth — the
  // exact rendered file is what is sent — and send_metadata.json records that
  // this was an auto-approved send.
  let sendInfo: SendPromptSuccess | undefined;
  let sendError: SendPromptError | undefined;
  if (options.autoApprove) {
    let terminal: PromptSendTerminal | undefined;
    try {
      const vibecodePath = getWorkspacePaths(options.repoRoot).vibecode;
      terminal = options.sendTerminal ?? createCliSendTerminal(options.repoRoot);
      const sendResult = await sendFinalPrompt({
        runDir: result.runDir,
        writer: terminal.writer,
        vibecodePath,
        runId: result.run_id,
        appendNewline: '\r',
        autoApprove: true,
      });
      if (sendResult.ok) sendInfo = sendResult;
      else sendError = sendResult.error;
    } catch (error) {
      sendError = {
        code: error instanceof ProviderNotConfiguredError || error instanceof LlmAdapterError
          ? error.code
          : (error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'SEND_FAILED'),
        message: error instanceof Error ? error.message : String(error),
        details: [],
      };
    } finally {
      await terminal?.close?.();
    }
  }

  const sendEnvelope = options.autoApprove
    ? sendInfo
      ? {
          ok: true as const,
          send_metadata: sendInfo.metadataPath,
          current_send_metadata: sendInfo.currentMetadataPath ?? null,
          sent_at: sendInfo.metadata.sent_at,
          auto_approve: sendInfo.metadata.auto_approve,
        }
      : { ok: false as const, error: sendError ?? { code: 'SEND_FAILED', message: 'auto-approve send failed', details: [] } }
    : undefined;

  if (options.json) {
    stdout.write(`${JSON.stringify({
      ok: true,
      data: {
        run_id: result.run_id,
        runDir: result.runDir,
        finalPromptPath: result.finalPromptPath,
        flash_input_path: result.flashInputPath,
        repo_atlas_path: result.repoAtlasPath,
        task_slice_path: result.taskSlicePath,
        relevance_selection_path: result.relevanceSelectionPath,
        flash_input_budget_path: result.flashInputBudgetPath,
        taskNormalizerEnabled: result.taskNormalizerEnabled ?? false,
        taskNormalizerOk: result.taskNormalizerOk ?? false,
        taskNormalizerLanguage: result.taskNormalizerLanguage ?? 'unknown',
        taskIntentPath: result.taskIntentPath,
        estimated_tokens: result.estimatedTokens,
        hard_max_tokens: result.hardMaxTokens,
        provider_called: result.providerCalled,
        auto_approve: Boolean(options.autoApprove),
        ...(sendEnvelope ? { send: sendEnvelope } : {}),
      },
      artifacts: result.artifacts,
      warnings: result.warnings,
    })}\n`);
    return result;
  }

  stdout.write(`run: ${result.run_id}\n`);
  stdout.write(`runDir: ${result.runDir}\n`);
  stdout.write(`final_prompt: ${result.finalPromptPath}\n`);
  stdout.write('artifacts:\n');
  for (const artifact of result.artifacts) {
    stdout.write(`  ${artifact}\n`);
  }
  if (options.autoApprove) {
    if (sendInfo) {
      stdout.write(`auto-approve: sent final_prompt.md (send_metadata: ${sendInfo.metadataPath})\n`);
    } else {
      stderr.write(`auto-approve send failed: ${sendError?.code ?? 'SEND_FAILED'} ${sendError?.message ?? ''}\n`);
    }
  } else {
    stdout.write('note: no terminal send in this checkpoint\n');
  }
  return result;
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

interface CliStructuredError {
  code: string;
  message: string;
  path: string;
  details: string[];
}

function makeCliStructuredError(code: string, message: string, pathValue = '', details: string[] = []): CliStructuredError {
  return { code, message, path: pathValue, details };
}

function emitCliStructuredError(error: CliStructuredError, options: { json?: boolean; prefix: string }): void {
  if (options.json) {
    console.log(JSON.stringify({ ok: false, error }));
  } else {
    console.error(`${options.prefix}: ${error.message}`);
    if (error.path) console.error(`path: ${error.path}`);
    for (const detail of error.details) console.error(`detail: ${detail}`);
  }
  process.exitCode = 1;
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

function codeGraphContextFallbackResult(
  mode: CodeGraphContextMode,
  error: unknown,
  transport: CodeGraphTransport = DEFAULT_CODEGRAPH_TRANSPORT,
): CodeGraphContextResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: true,
    used: false,
    mode,
    reason: 'CODEGRAPH_CONTEXT_FAILED',
    warnings: [`CODEGRAPH_CONTEXT_FAILED: ${message}`],
    transportRequested: transport,
    transportUsed: 'none',
    mcpAttempted: transport === 'mcp' || transport === 'auto',
    fallbackUsed: false,
    error: {
      code: 'CODEGRAPH_CONTEXT_FAILED',
      message,
      details: [],
    },
  };
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
}): Promise<ContextBuildResult> {
  const taskNormalizerEnabled = opts.taskNormalizerEnabled === true;
  const normalizerWarnings: string[] = [];
  let normalizerProviderConfig: Parameters<typeof runTaskNormalizer>[0]['providerConfig'];
  let normalizerModelInfo: Parameters<typeof runTaskNormalizer>[0]['modelInfo'];
  if (taskNormalizerEnabled) {
    const ensured = ensureLocalConfig({ repoRoot: opts.repoRoot, env: process.env });
    const resolved = resolveFlashConfig({
      repoRoot: opts.repoRoot,
      env: process.env,
      live: true,
      mock: false,
      localCreatedFromGlobal: ensured.createdFromGlobal,
    });
    normalizerWarnings.push(...resolved.resolution.warnings);
    normalizerProviderConfig = resolved.providerConfig ?? undefined;
    if (normalizerProviderConfig) {
      normalizerModelInfo = {
        provider: resolved.resolution.provider ?? 'unknown',
        model: resolved.resolution.model ?? 'unknown',
      };
    } else if (resolved.error) {
      normalizerWarnings.push(`TASK_NORMALIZER_PROVIDER_FALLBACK: ${resolved.error.code}: ${resolved.error.message}`);
      normalizerWarnings.push(...resolved.error.details);
    }
  }

  const taskIntent = await runTaskNormalizer({
    task: opts.task,
    enabled: taskNormalizerEnabled,
    providerConfig: normalizerProviderConfig,
    modelInfo: normalizerModelInfo,
  });
  const result = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot, taskIntent });

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

  const taskIntentArtifacts = writeTaskIntentArtifacts(result.runDir, taskIntent);
  const flashDir = path.join(result.runDir, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });

  const codegraphMode = opts.codegraphMode ?? 'detect-only';
  const codegraphTransport: CodeGraphTransport = opts.codegraphTransport ?? readCodeGraphTransportSetting({ env: process.env }).transport;
  const codegraphTask = buildCodeGraphTask(opts.task, taskIntent);
  let codegraphResult: CodeGraphContextResult = {
    ok: true,
    used: false,
    mode: codegraphMode,
    reason: 'DETECT_ONLY',
    warnings: [],
    transportRequested: codegraphTransport,
    transportUsed: 'none',
    mcpAttempted: false,
    fallbackUsed: false,
  };
  try {
    codegraphResult = await buildCodeGraphContext({
      repoRoot: opts.repoRoot,
      task: codegraphTask,
      mode: codegraphMode,
      transport: codegraphTransport,
      ...(opts.codegraphRunner ? { runner: opts.codegraphRunner } : {}),
      ...(opts.codegraphReadinessProvider ? { readinessProvider: opts.codegraphReadinessProvider } : {}),
      ...(opts.codegraphCommand ? { command: opts.codegraphCommand } : {}),
      ...(opts.codegraphMcpRunner ? { mcpRunner: opts.codegraphMcpRunner } : {}),
    });
  } catch (error) {
    codegraphResult = codeGraphContextFallbackResult(codegraphMode, error, codegraphTransport);
  }
  const codegraphArtifacts = writeCodeGraphContextArtifacts({ runDir: result.runDir, result: codegraphResult });
  augmentExternalToolsWithCodeGraphContext(result.scanDir, codegraphResult);

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
      taskIntent,
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
      taskIntentArtifacts.jsonPath,
      taskIntentArtifacts.mdPath,
      result.runManifestPath,
      path.join(result.runDir, 'scanner_config.json'),
      path.join(result.runDir, 'skills', 'skills_catalog.json'),
      ...Object.values(result.artifacts),
      codegraphArtifacts.usageArtifact,
      ...(codegraphArtifacts.contextArtifact ? [codegraphArtifacts.contextArtifact] : []),
      ...(codegraphArtifacts.repoAtlasArtifact ? [codegraphArtifacts.repoAtlasArtifact] : []),
      ...(codegraphArtifacts.repoAtlasJsonArtifact ? [codegraphArtifacts.repoAtlasJsonArtifact] : []),
      ...(codegraphArtifacts.legacyRepoAtlasArtifact ? [codegraphArtifacts.legacyRepoAtlasArtifact] : []),
      ...(codegraphArtifacts.legacyRepoAtlasJsonArtifact ? [codegraphArtifacts.legacyRepoAtlasJsonArtifact] : []),
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
      warnings: [...result.warnings, ...normalizerWarnings, ...(taskIntent.ok ? [] : taskIntent.warnings), ...codegraphResult.warnings, ...flashManifest.warnings],
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
  flashProvider?: string;
  flashModel?: string;
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
    const resolvedSystemPrompt = resolveFlashSystemPrompt({
      repoRoot: opts.repoRoot,
      bundledPromptPath: BUNDLED_FLASH_SYSTEM_PROMPT_PATH,
      env: process.env,
    });

    const resolved = resolveFlashConfig({
      repoRoot: opts.repoRoot,
      env: process.env,
      live: opts.live,
      mock: opts.mock,
      cliFlags: { provider: opts.flashProvider, model: opts.flashModel },
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
      adapterResult = await liveAdapter.run({
        flashInputMd,
        systemPrompt: resolvedSystemPrompt.content,
        flashDir,
        runId,
        workspaceRoot: opts.repoRoot,
      });
    } else {
      const adapter = new MockFlashAdapter();
      adapterResult = await adapter.run({
        flashInputMd,
        systemPrompt: resolvedSystemPrompt.content,
        flashDir,
        runId,
        workspaceRoot: opts.repoRoot,
      });
    }

    const flashSystemPromptArtifacts = writeFlashSystemPromptArtifacts(flashDir, resolvedSystemPrompt);
    const configResolutionPath = writeConfigResolution(runDir, resolved.resolution);
    const adapterMeta = adapterResult.meta as Record<string, unknown>;
    enrichFlashOutputMeta(flashDir, {
      provider: (typeof adapterMeta.provider === 'string' ? adapterMeta.provider : resolved.resolution.provider) ?? null,
      provider_label: resolved.resolution.provider_label,
      model: (typeof adapterMeta.model === 'string' ? adapterMeta.model : resolved.resolution.model) ?? null,
      model_label: resolved.resolution.model_label,
      live: typeof adapterMeta.live === 'boolean' ? adapterMeta.live : false,
      baseUrl_host: (typeof adapterMeta.baseUrl_host === 'string' ? adapterMeta.baseUrl_host : resolved.resolution.baseUrl_host) ?? null,
      config_source: resolved.resolution.selected_config_source,
      config_resolution_path: configResolutionPath,
    });

    const artifacts = [
      flashSystemPromptArtifacts.promptPath,
      flashSystemPromptArtifacts.metaPath,
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
      warnings: [...resolved.resolution.warnings, ...resolvedSystemPrompt.warnings],
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

  registerDoctorCommand(program);
  registerWorkspaceCommands(program);

  registerConfigCommands(program);

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


  registerCodeGraphCommands(program, { makeCliStructuredError, emitCliStructuredError });

  // context-build command
  program
    .command('context-build <task>')
    .description('create a run, scan the repo, and build flash input artifacts')
    .option('--repo <path>', 'repository root (default: cwd)', process.cwd())
    .option('--codegraph-mode <mode>', 'CodeGraph context mode: detect-only | use-existing')
    .option('--task-normalizer', 'Enable Task Normalizer')
    .option('--no-task-normalizer', 'Disable Task Normalizer (default)', false)
    .option('--json', 'output canonical JSON envelope')
    .action(async (task: string, options: { repo?: string; codegraphMode?: string; taskNormalizer?: boolean; json?: boolean }) => {
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
    .option('--json', 'Output canonical JSON envelope')
    .action(async (args: string[] | undefined, options: { repo: string; mock?: boolean; live?: boolean; flashProvider?: string; flashModel?: string; codegraph?: boolean; codegraphMode?: string; taskNormalizer?: boolean; autoApprove?: boolean; json?: boolean }) => {
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
        json: options.json,
      });
      if (result.ok === false) process.exitCode = 1;
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
