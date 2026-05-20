import fs from 'fs';
import path from 'path';

import type { FlashAdapterResult, FlashInput, LlmAdapter } from './base.js';
import { LlmAdapterError } from './errors.js';
import { FlashToolRunner } from './tool_runner.js';
import { parseFlashOutput } from '../../core/context/markdown_flash_output_parser.js';
import { extractFlashOutputMeta, writeFlashOutputMeta } from '../../core/context/flash_output_meta.js';

function buildMockMarkdown(runId: string, flashInputMd: string): string {
  const firstInputLine = flashInputMd
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? 'No flash input content.';

  return [
    '# Task Summary',
    `Mock flash run for ${runId}.`,
    `Input anchor: ${firstInputLine}`,
    '',
    '# Relevant Files',
    '- README.md — deterministic mock default',
    '',
    '# Files To Read With Tools',
    '- README.md — inspect repository overview before implementation',
    '',
    '# Relevant Tests',
    '- pnpm test — run the default test suite',
    '',
    '# Commands To Run',
    '- pnpm test — run the default test suite',
    '',
    '# Selected Skills',
    '',
    '# Cautions',
    '- mock adapter output; do not treat as live model result',
    '',
    '# Context Pack',
    `This deterministic mock context pack was generated for run ${runId}.`,
    'It is intended for local tests and smoke checks only.',
    '',
  ].join('\n');
}

export class MockFlashAdapter implements LlmAdapter {
  async run(input: FlashInput): Promise<FlashAdapterResult> {
    const runDir = path.join(path.resolve(input.workspaceRoot), '.vibecode', 'runs', input.runId);
    const flashDir = path.join(runDir, 'flash');
    const flashInputPath = path.join(flashDir, 'flash_input.md');

    if (!fs.existsSync(flashInputPath)) {
      throw new LlmAdapterError(`missing flash_input.md for run ${input.runId}`, {
        code: 'FLASH_INPUT_NOT_FOUND',
        path: flashInputPath,
        details: ['Run context-build before flash run, or choose a run containing flash/flash_input.md.'],
      });
    }

    const tools = new FlashToolRunner({ workspaceRoot: input.workspaceRoot, runId: input.runId });
    const savedFlashInput = tools.readArtifact('flash/flash_input.md');
    const flashInputMd = savedFlashInput || input.flashInputMd;
    const flashOutputMd = buildMockMarkdown(input.runId, flashInputMd);
    const parsed = parseFlashOutput(flashOutputMd, path.join(flashDir, 'flash_output.md'));

    if (!parsed.ok) {
      throw new LlmAdapterError(parsed.diagnostic?.message ?? 'mock flash output failed validation', {
        code: 'FLASH_OUTPUT_INVALID',
        path: parsed.diagnostic?.path,
        details: parsed.diagnostic?.details,
      });
    }

    fs.mkdirSync(flashDir, { recursive: true });
    const flashOutputPath = path.join(flashDir, 'flash_output.md');
    const toolCallsPath = path.join(flashDir, 'tool_calls.json');
    fs.writeFileSync(flashOutputPath, flashOutputMd, 'utf8');

    const extractedMeta = extractFlashOutputMeta(parsed.sections);
    writeFlashOutputMeta(flashDir, extractedMeta);

    const toolCalls = tools.getToolCalls();
    fs.writeFileSync(toolCallsPath, `${JSON.stringify(toolCalls, null, 2)}\n`, 'utf8');

    return {
      flashOutputMd,
      toolCalls,
      meta: {
        provider: 'mock',
        live: false,
        run_id: input.runId,
        flash_output: flashOutputPath,
      },
    };
  }
}
