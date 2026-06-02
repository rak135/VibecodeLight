import {
  type CodeGraphContextMode,
} from '../../adapters/codegraph/codegraph_context.js';
import {
  type CodeGraphMcpContextRunner,
} from '../../adapters/codegraph/codegraph_mcp.js';
import {
  type CodeGraphTransport,
} from '../../adapters/codegraph/codegraph_transport.js';
import type { LlmAdapter } from '../../adapters/llm/base.js';
import { LlmAdapterError, ProviderNotConfiguredError } from '../../adapters/llm/errors.js';
import { readCodeGraphTransportSetting } from '../config/index.js';
import { runPromptPipeline } from '../prompting/index.js';
import type { PipelineEvent, PromptPipelineResult } from '../prompting/index.js';
import {
  closeSession,
  sendFinalPrompt,
  startTerminalSession,
  type SendPromptError,
  type SendPromptSuccess,
  type TerminalSendWriter,
} from '../terminal/index.js';
import { getWorkspacePaths } from '../workspace/paths.js';

export const BAD_PROVIDER_RESPONSE_TIP = 'Tip: This indicates an API endpoint, auth, model, or provider configuration error. Check pnpm vibecode config show for your current provider configuration.';

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

export interface PromptCommandPhaseOptions {
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

function createDefaultPromptSendTerminal(repoRoot: string): PromptSendTerminal {
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

export async function performPromptCommandPhase(options: PromptCommandPhaseOptions): Promise<PromptPipelineResult> {
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
      terminal = options.sendTerminal ?? createDefaultPromptSendTerminal(options.repoRoot);
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
