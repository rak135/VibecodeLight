import fs from 'fs';
import path from 'path';

import {
  buildCodeGraphContext,
  writeCodeGraphContextArtifacts,
  type CodeGraphContextMode,
  type CodeGraphContextResult,
  type CodeGraphContextRunner,
  type CodeGraphReadinessProvider,
} from '../../adapters/codegraph/codegraph_context.js';
import type { CodeGraphMcpContextRunner } from '../../adapters/codegraph/codegraph_mcp.js';
import {
  DEFAULT_CODEGRAPH_TRANSPORT,
  type CodeGraphTransport,
} from '../../adapters/codegraph/codegraph_transport.js';
import { runTaskNormalizer, writeTaskIntentArtifacts } from '../../adapters/task_normalizer/index.js';
import {
  ensureLocalConfig,
  readCodeGraphTransportSetting,
  resolveFlashConfig,
} from '../config/index.js';
import {
  buildFlashInput,
  buildFlashInputManifest,
  FlashInputManifestError,
  formatPreviousRunSummary,
  getPreviousRunSummary,
} from '../context/index.js';
import { RunManifest } from '../models/index.js';
import { buildCodeGraphTask } from '../prompting/codegraph_task.js';
import { augmentExternalToolsWithCodeGraphContext } from '../scanning/external_tools.js';
import { updateCurrent } from './current.js';
import { performScanPhase, writeRunManifest } from './scan_phase.js';

export interface ContextBuildPhaseOptions {
  task: string;
  repoRoot: string;
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
}

export interface ContextBuildPhaseResult {
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

export async function performContextBuildPhase(
  opts: ContextBuildPhaseOptions,
): Promise<ContextBuildPhaseResult> {
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
