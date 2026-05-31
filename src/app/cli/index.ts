import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { Command } from 'commander';
import YAML from 'yaml';

import {
  getCodeGraphStatus,
  initializeCodeGraphRepo,
  reindexCodeGraphRepo,
  syncCodeGraphRepo,
} from '../../adapters/codegraph/codegraph_actions.js';
import {
  buildCodeGraphContext,
  writeCodeGraphContextArtifacts,
  type CodeGraphContextMode,
  type CodeGraphContextResult,
  type CodeGraphContextRunner,
  type CodeGraphReadinessProvider,
} from '../../adapters/codegraph/codegraph_context.js';
import type { LlmAdapter } from '../../adapters/llm/base.js';
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
import { augmentExternalToolsWithCodeGraphContext } from '../../core/scanning/external_tools.js';
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
import type { TaskIntent } from '../../adapters/task_normalizer/types.js';

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
  const result = await runPromptPipeline({
    task: options.task,
    repoRoot: options.repoRoot,
    mock: options.mock,
    live: options.live,
    flashProvider: options.flashProvider,
    flashModel: options.flashModel,
    codegraphMode: options.codegraphMode,
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

function codeGraphContextFallbackResult(mode: CodeGraphContextMode, error: unknown): CodeGraphContextResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: true,
    used: false,
    mode,
    reason: 'CODEGRAPH_CONTEXT_FAILED',
    warnings: [`CODEGRAPH_CONTEXT_FAILED: ${message}`],
    error: {
      code: 'CODEGRAPH_CONTEXT_FAILED',
      message,
      details: [],
    },
  };
}

function formatCodeGraphStatusLine(status: { available: boolean; initialized: boolean; version?: string }): string {
  if (!status.available) return 'codegraph status: not available';
  const parts = ['codegraph status: available', status.initialized ? 'initialized' : 'not initialized'];
  if (status.version) parts.push(status.version);
  return parts.join(' · ');
}

function buildCodeGraphActionFailure(action: 'status' | 'init' | 'sync' | 'reindex', repoRoot: string, message: string, details: string[] = []): CliStructuredError {
  return makeCliStructuredError(
    `CODEGRAPH_${action.toUpperCase()}_FAILED`,
    message,
    repoRoot,
    details,
  );
}

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
  codegraphMode?: CodeGraphContextMode;
  taskNormalizerEnabled?: boolean;
  /** Test seam for pipeline-level CodeGraph behavior; CLI never sets this. */
  codegraphRunner?: CodeGraphContextRunner;
  /** Test seam for pipeline-level CodeGraph behavior; CLI never sets this. */
  codegraphReadinessProvider?: CodeGraphReadinessProvider;
  /** Test seam for pipeline-level CodeGraph behavior; CLI never sets this. */
  codegraphCommand?: string;
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
  const codegraphTask = buildCodeGraphTask(opts.task, taskIntent);
  let codegraphResult: CodeGraphContextResult = { ok: true, used: false, mode: codegraphMode, reason: 'DETECT_ONLY', warnings: [] };
  try {
    codegraphResult = await buildCodeGraphContext({
      repoRoot: opts.repoRoot,
      task: codegraphTask,
      mode: codegraphMode,
      ...(opts.codegraphRunner ? { runner: opts.codegraphRunner } : {}),
      ...(opts.codegraphReadinessProvider ? { readinessProvider: opts.codegraphReadinessProvider } : {}),
      ...(opts.codegraphCommand ? { command: opts.codegraphCommand } : {}),
    });
  } catch (error) {
    codegraphResult = codeGraphContextFallbackResult(codegraphMode, error);
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
      console.log(`provider_label: ${r.provider_label ?? '(none)'}`);
      console.log(`model: ${r.model ?? '(none)'} [${r.source_map.model}]`);
      console.log(`model_label: ${r.model_label ?? '(none)'}`);
      console.log(`baseUrl_host: ${r.baseUrl_host ?? '(none)'} [${r.source_map.baseUrl}]`);
      console.log(`api_key_env: ${r.api_key_env ?? '(none)'}`);
      console.log(`api_key: ${r.has_api_key ? 'configured' : 'missing'} [${r.source_map.apiKey}]`);
      console.log(`global_config: ${r.global_config_path} (${r.global_config_exists ? 'exists' : 'absent'})`);
      console.log(`global_env: ${r.global_env_path} (${r.global_env_exists ? 'exists' : 'absent'})`);
      console.log(`local_config: ${r.local_config_path} (${r.local_config_exists ? 'exists' : 'absent'})`);
      console.log('providers:');
      for (const p of r.providers) {
        console.log(`  ${p.id} [${p.origin}] api_key=${p.has_api_key ? 'configured' : 'missing'} (${p.api_key_env ?? 'no api_key_env'})`);
      }
      if (resolved.error) {
        console.log(`error: ${resolved.error.code} ${resolved.error.message}`);
      }
      for (const warning of r.warnings) {
        console.log(`warning: ${warning}`);
      }
    });

  config
    .command('providers')
    .description('List configured providers (and whether each has an API key) — never prints keys')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const resolved = resolveFlashConfig({ repoRoot, env: process.env });
      const r = resolved.resolution;
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            providers: r.providers,
            active_provider: r.provider,
            active_model: r.model,
            config_source: r.selected_config_source,
            local_config_path: r.local_config_path,
            global_config_path: r.global_config_path,
            global_env_path: r.global_env_path,
          },
          artifacts: [],
          warnings: r.warnings,
        }));
        return;
      }
      console.log(`active_provider: ${r.provider ?? '(none)'}`);
      console.log(`active_model: ${r.model ?? '(none)'}`);
      console.log(`config_source: ${r.selected_config_source}`);
      console.log('providers:');
      for (const p of r.providers) {
        console.log(`  ${p.id}\t${p.label ?? ''}\t[${p.origin}]\tapi_key=${p.has_api_key ? 'configured' : 'missing'} (${p.api_key_env ?? 'no api_key_env'})\tmodels=${p.models.length}`);
      }
    });

  config
    .command('models')
    .description('List models per configured provider — never prints keys')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--provider <id>', 'Limit to a single provider id')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; provider?: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const resolved = resolveFlashConfig({ repoRoot, env: process.env });
      const r = resolved.resolution;
      const filtered = options.provider ? r.providers.filter((p) => p.id === options.provider) : r.providers;
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            providers: filtered.map((p) => ({ id: p.id, label: p.label, has_api_key: p.has_api_key, api_key_env: p.api_key_env, models: p.models })),
            active_provider: r.provider,
            active_model: r.model,
            config_source: r.selected_config_source,
          },
          artifacts: [],
          warnings: r.warnings,
        }));
        return;
      }
      for (const p of filtered) {
        console.log(`${p.id} [${p.origin}]:`);
        if (p.models.length === 0) {
          console.log('  (no models)');
        }
        for (const m of p.models) {
          const active = r.provider === p.id && r.model === m.id ? ' *active' : '';
          console.log(`  ${m.id}\t${m.label ?? ''}\t${m.role ?? ''}${active}`);
        }
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
    .description('Sync global AppData config into this repository (global → local only)')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--from-global', 'Overwrite local config from global config')
    .option('--to-global', '[disabled] Local-to-global sync is not allowed')
    .option('--json', 'Output canonical JSON envelope')
    .action((options: { repo: string; fromGlobal?: boolean; toGlobal?: boolean; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);

      if (options.toGlobal) {
        const error = {
          code: 'CONFIG_SYNC_TO_GLOBAL_DISABLED',
          message: 'Local-to-global config sync is disabled. Use global-to-local sync only.',
          path: '',
          details: [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`config sync failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      if (!options.fromGlobal) {
        const error = {
          code: 'SYNC_DIRECTION_REQUIRED',
          message: 'config sync requires --from-global',
          path: '',
          details: [],
        };
        if (options.json) console.log(JSON.stringify({ ok: false, error }));
        else console.error(`config sync failed: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      const direction = 'from-global' as const;
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

  const codegraph = program.command('codegraph').description('CodeGraph repository operations');

  codegraph
    .command('status')
    .description('Show CodeGraph availability and initialization status for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action(async (options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      const result = await getCodeGraphStatus(repoRoot);
      if (options.json) {
        console.log(JSON.stringify({
          ok: true,
          data: {
            available: result.available,
            initialized: result.initialized,
            version: result.version,
          },
          artifacts: [],
          warnings: result.warnings,
        }));
        return;
      }
      console.log(formatCodeGraphStatusLine(result));
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
    });

  const runCodeGraphAction = async (
    action: 'init' | 'sync' | 'reindex',
    repoRoot: string,
    runner: () => Promise<Awaited<ReturnType<typeof initializeCodeGraphRepo>>>,
    json?: boolean,
  ): Promise<void> => {
    const result = await runner();
    if (!result.ok) {
      emitCliStructuredError(
        buildCodeGraphActionFailure(
          action,
          repoRoot,
          result.error?.message ?? `codegraph ${action} failed`,
          [
            ...(result.stderrSummary ? [result.stderrSummary] : []),
            ...(result.stdoutSummary ? [result.stdoutSummary] : []),
            ...(result.error?.details ? [result.error.details] : []),
          ],
        ),
        { json, prefix: `codegraph ${action} failed` },
      );
      return;
    }

    if (json) {
      console.log(JSON.stringify({
        ok: true,
        data: {
          stdout: result.stdoutSummary ?? '',
          stderr: result.stderrSummary ?? '',
        },
        artifacts: [],
        warnings: [],
      }));
      return;
    }

    const summary = result.stdoutSummary?.trim() || result.stderrSummary?.trim();
    console.log(summary ? `codegraph ${action}: ok · ${summary}` : `codegraph ${action}: ok`);
  };

  codegraph
    .command('init')
    .description('Initialize CodeGraph for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action(async (options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      await runCodeGraphAction('init', repoRoot, () => initializeCodeGraphRepo(repoRoot), options.json);
    });

  codegraph
    .command('sync')
    .description('Sync an existing CodeGraph index for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action(async (options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      await runCodeGraphAction('sync', repoRoot, () => syncCodeGraphRepo(repoRoot), options.json);
    });

  codegraph
    .command('reindex')
    .description('Force a full CodeGraph reindex for a repository')
    .option('--repo <path>', 'Repository path', process.cwd())
    .option('--json', 'Output canonical JSON envelope')
    .action(async (options: { repo: string; json?: boolean }) => {
      const repoRoot = path.resolve(options.repo);
      await runCodeGraphAction('reindex', repoRoot, () => reindexCodeGraphRepo(repoRoot), options.json);
    });

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
