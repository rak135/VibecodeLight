import path from 'path';

import { PtyError } from '../../adapters/pty/index.js';
import { buildGitStatusCommand, buildMarkerCommand } from './platform.js';
import { closeSession, startTerminalSession, TerminalSession, writeAndWait } from './session.js';

export interface TerminalDemoResult {
  ok: boolean;
  shell?: string;
  pid?: number;
  cwd?: string;
  excerpt?: string;
  artifacts?: string[];
  warnings?: string[];
  error?: { code: string; message: string };
}

export interface TerminalDemoOptions {
  repo?: string;
  command?: string;
  json?: boolean;
}

const DEFAULT_MARKER = 'VIBECODE_PTY_OK';
const DEFAULT_COMMAND = buildMarkerCommand(DEFAULT_MARKER);
const COMMAND_TIMEOUT_MS = 15_000;

function terminalError(error: unknown): { code: string; message: string } {
  if (error instanceof PtyError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'TERMINAL_START_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function runPrimaryCommand(session: TerminalSession, command: string | undefined): Promise<void> {
  if (!command) {
    await writeAndWait(session, DEFAULT_COMMAND, DEFAULT_MARKER, COMMAND_TIMEOUT_MS);
    return;
  }

  const marker = `VIBECODE_PTY_COMMAND_DONE_${Date.now()}`;
  const echoCmd = buildMarkerCommand(marker);
  const chain = process.platform === 'win32' ? ';' : '&&';
  await writeAndWait(session, `${command}${chain} ${echoCmd}`, marker, COMMAND_TIMEOUT_MS);
}

async function runGitStatus(session: TerminalSession, warnings: string[]): Promise<void> {
  const marker = `VIBECODE_GIT_STATUS_DONE_${Date.now()}`;
  try {
    await writeAndWait(session, buildGitStatusCommand(marker), marker, COMMAND_TIMEOUT_MS);
  } catch (error) {
    const diagnostic = terminalError(error);
    warnings.push(`git status demo did not complete: ${diagnostic.message}`);
  }
}

export async function runTerminalDemo(options: TerminalDemoOptions = {}): Promise<TerminalDemoResult> {
  const repo = path.resolve(options.repo ?? process.cwd());
  const warnings: string[] = [];
  let session: TerminalSession | undefined;

  try {
    session = startTerminalSession({ cwd: repo, cols: 120, rows: 30, excerpt: { maxLines: 500, maxChars: 80_000 } });
    await runPrimaryCommand(session, options.command);
    await runGitStatus(session, warnings);

    const excerpt = session.excerpt.getCleanText();

    return {
      ok: true,
      shell: session.metadata.shell,
      pid: session.metadata.pid,
      cwd: session.metadata.cwd,
      excerpt,
      artifacts: [],
      warnings,
    };
  } catch (error) {
    return {
      ok: false,
      cwd: repo,
      warnings,
      artifacts: [],
      error: terminalError(error),
    };
  } finally {
    await closeSession(session);
  }
}
