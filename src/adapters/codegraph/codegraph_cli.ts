import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { CodeGraphDetection } from './codegraph_types.js';

export const CODEGRAPH_DIR_NAME = '.codegraph';
export const CODEGRAPH_COMMAND = 'codegraph';

/**
 * Result of probing the CodeGraph command for availability/version.
 *
 * - `found=false` means the command could not be spawned (e.g. ENOENT).
 * - `found=true` with a `version` means the read-only `--version` probe worked.
 * - `found=true` with a `warning` means the command exists but the version
 *   probe failed; the command is still considered available.
 */
export interface CodeGraphVersionProbeResult {
  found: boolean;
  version?: string;
  warning?: string;
}

export type CodeGraphVersionProbe = (command: string) => CodeGraphVersionProbeResult;

export interface DetectCodeGraphOptions {
  /** Override the probe (used by tests to avoid spawning a real process). */
  versionProbe?: CodeGraphVersionProbe;
  /** Override the command name. Defaults to `codegraph`. */
  command?: string;
}

function parseVersion(stdout: string | undefined): string | undefined {
  const text = (stdout ?? '').trim();
  if (!text) return undefined;
  return text.split(/\r?\n/)[0].trim() || undefined;
}

/**
 * Default read-only probe. Runs `codegraph --version` only. This never mutates
 * the repository and never triggers init/index/sync/watch.
 */
export function defaultVersionProbe(command: string): CodeGraphVersionProbeResult {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { found: false, warning: message };
  }

  if (result.error) {
    return { found: false, warning: result.error.message };
  }
  if (result.status === 0) {
    const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString();
    return { found: true, version: parseVersion(stdout) };
  }
  // Command spawned but the version probe failed: it exists, but version unknown.
  return {
    found: true,
    warning: `codegraph --version exited with status ${result.status ?? 'null'}`,
  };
}

/**
 * Detect optional CodeGraph availability and `.codegraph/` initialization.
 *
 * Detect-only contract:
 * - missing command is not an error (available=false + warning);
 * - missing `.codegraph/` is not an error (initialized=false);
 * - any probe/check failure becomes a warning, never a thrown error;
 * - nothing is created and no init/index/sync/watch command is ever run.
 */
export async function detectCodeGraph(
  repoRoot: string,
  options: DetectCodeGraphOptions = {},
): Promise<CodeGraphDetection> {
  const command = options.command ?? CODEGRAPH_COMMAND;
  const probe = options.versionProbe ?? defaultVersionProbe;
  const warnings: string[] = [];

  // initialized: does <repoRoot>/.codegraph/ exist? (read-only stat)
  let initialized = false;
  const codegraphDirAbs = path.join(repoRoot, CODEGRAPH_DIR_NAME);
  try {
    initialized = fs.existsSync(codegraphDirAbs) && fs.statSync(codegraphDirAbs).isDirectory();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`CODEGRAPH_DIR_CHECK_FAILED: ${message}`);
  }

  // available: is the codegraph command found / callable?
  let probeResult: CodeGraphVersionProbeResult;
  try {
    probeResult = probe(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    probeResult = { found: false, warning: message };
  }

  let available = false;
  let version: string | undefined;
  if (probeResult.found) {
    available = true;
    version = probeResult.version;
    if (!version && probeResult.warning) {
      warnings.push(`CODEGRAPH_VERSION_UNAVAILABLE: ${probeResult.warning}`);
    }
  } else {
    const detail = probeResult.warning ? `: ${probeResult.warning}` : '';
    warnings.push(`CODEGRAPH_NOT_FOUND: codegraph command was not found or not callable${detail}`);
  }

  const detection: CodeGraphDetection = {
    available,
    initialized,
    warnings,
  };
  if (available) detection.command = command;
  if (version) detection.version = version;
  if (initialized) detection.codegraphDir = CODEGRAPH_DIR_NAME;
  return detection;
}
