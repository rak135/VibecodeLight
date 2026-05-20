import fs from 'fs';
import path from 'path';

import { MockFlashAdapter } from '../../adapters/llm/mock_flash.js';
import {
  buildFlashInput,
  buildFlashInputManifest,
  contextFinalizeErrorToDiagnostic,
  finalizeContext,
  formatPreviousRunSummary,
  getPreviousRunSummary,
} from '../context/index.js';
import { renderFinalPrompt } from './renderer.js';
import { updateCurrent } from '../runs/current.js';
import { performScanPhase, writeRunManifest } from '../runs/scan_phase.js';
import type { RunManifest } from '../models/index.js';

export interface PromptPipelineOptions {
  task: string;
  repoRoot: string;
  mock: boolean;
  live?: boolean;
}

export interface PromptPipelineSuccess {
  ok: true;
  run_id: string;
  runDir: string;
  finalPromptPath: string;
  artifacts: string[];
  warnings: string[];
}

export interface PromptPipelineError {
  ok: false;
  error: {
    code: string;
    message: string;
    path?: string;
    details: string[];
  };
}

export type PromptPipelineResult = PromptPipelineSuccess | PromptPipelineError;

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function errorResult(code: string, message: string, pathValue = '', details: string[] = []): PromptPipelineError {
  return {
    ok: false,
    error: {
      code,
      message,
      path: pathValue,
      details,
    },
  };
}

export async function runPromptPipeline(opts: PromptPipelineOptions): Promise<PromptPipelineResult> {
  if (opts.mock === false) {
    return errorResult(
      'MOCK_REQUIRED',
      'use --mock flag; live provider not configured for this checkpoint',
      '',
      [],
    );
  }

  const scan = await performScanPhase({ task: opts.task, repoRoot: opts.repoRoot });
  if (scan.status === 'error') {
    return errorResult('SCANNER_FAILED', scan.diagnostic, scan.scanDir, []);
  }

  const flashDir = path.join(scan.runDir, 'flash');
  fs.mkdirSync(flashDir, { recursive: true });

  const artifacts: string[] = [
    path.join(scan.runDir, 'user_prompt.md'),
    scan.runManifestPath,
    path.join(scan.runDir, 'scanner_config.json'),
    path.join(scan.scanDir, 'scan_manifest.json'),
    path.join(scan.runDir, 'skills', 'skills_catalog.json'),
    ...Object.values(scan.artifacts),
  ];
  const warnings = [...scan.warnings];

  try {
    const flashManifest = buildFlashInputManifest({
      run_id: scan.run_id,
      task: opts.task,
      repo_root: opts.repoRoot,
      runDir: scan.runDir,
    });
    const previousRunSummary = formatPreviousRunSummary(
      getPreviousRunSummary({
        vibecodePath: scan.vibecodePath,
        currentRunId: scan.run_id,
      }),
    );
    const flashInput = buildFlashInput({
      run_id: scan.run_id,
      task: opts.task,
      repo_root: opts.repoRoot,
      runDir: scan.runDir,
      previousRunSummary,
      manifest: flashManifest,
    });
    const flashManifestPath = path.join(flashDir, 'flash_input_manifest.json');
    const flashInputPath = path.join(flashDir, 'flash_input.md');
    fs.writeFileSync(flashManifestPath, `${JSON.stringify(flashManifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(flashInputPath, flashInput, 'utf8');
    artifacts.push(flashManifestPath, flashInputPath);
    warnings.push(...flashManifest.warnings);

    const adapter = new MockFlashAdapter();
    await adapter.run({ flashInputMd: flashInput, runId: scan.run_id, workspaceRoot: opts.repoRoot });
    artifacts.push(
      path.join(flashDir, 'flash_output.md'),
      path.join(flashDir, 'flash_output_meta.json'),
      path.join(flashDir, 'tool_calls.json'),
    );

    const contextResult = finalizeContext(scan.runDir);
    artifacts.push(...contextResult.artifacts);
    warnings.push(...contextResult.warnings);

    const doneManifest: RunManifest = {
      ...scan.manifest,
      status: 'done',
    };
    writeRunManifest(scan.runManifestPath, doneManifest);

    const renderResult = renderFinalPrompt(scan.runDir, { vibecodePath: scan.vibecodePath });
    if (!renderResult.ok) {
      return {
        ok: false,
        error: renderResult.error ?? {
          code: 'PROMPT_RENDER_FAILED',
          message: 'prompt render failed',
          path: path.join(scan.runDir, 'output', 'final_prompt.md'),
          details: [],
        },
      };
    }

    await updateCurrent(scan.vibecodePath, doneManifest);

    const finalPromptPath = path.join(scan.runDir, 'output', 'final_prompt.md');
    artifacts.push(...(renderResult.artifacts ?? [finalPromptPath]));
    warnings.push(...(renderResult.warnings ?? []));

    return {
      ok: true,
      run_id: scan.run_id,
      runDir: scan.runDir,
      finalPromptPath,
      artifacts: unique(artifacts),
      warnings,
    };
  } catch (error) {
    const diagnostic = contextFinalizeErrorToDiagnostic(error, scan.runDir);
    return {
      ok: false,
      error: {
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
        details: diagnostic.details,
      },
    };
  }
}
