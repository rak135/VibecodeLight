import fs from 'fs';
import os from 'os';
import path from 'path';

import type { LlmAdapter } from '../../../src/adapters/llm/base.js';
import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';
import type { PipelineEvent, PipelineEventPhase } from '../../../src/core/prompting/pipeline_events.js';

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

async function runMock(opts: { taskNormalizerEnabled?: boolean; task?: string } = {}): Promise<{
  events: PipelineEvent[];
  runDir: string;
  warnings: string[];
  persistedProgressJsonl?: string;
}> {
  const repoRoot = makeRepo('vibecode-pipeline-progress-cov-');
  const events: PipelineEvent[] = [];
  try {
    const result = await runPromptPipeline({
      task: opts.task ?? 'Pipeline progress coverage test',
      repoRoot,
      mock: true,
      taskNormalizerEnabled: opts.taskNormalizerEnabled === true,
      onProgress: (event) => events.push(event),
    });
    if (!result.ok) throw new Error(result.error.message);
    const progressPath = path.join(result.runDir, 'output', 'progress_events.jsonl');
    const persistedProgressJsonl = fs.existsSync(progressPath)
      ? fs.readFileSync(progressPath, 'utf8')
      : undefined;
    return {
      events,
      runDir: result.runDir,
      warnings: result.warnings,
      ...(persistedProgressJsonl !== undefined ? { persistedProgressJsonl } : {}),
    };
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function phases(events: PipelineEvent[]): PipelineEventPhase[] {
  return events.map((event) => event.phase);
}

describe('pipeline progress event coverage (full pipeline)', () => {
  test('every event has phase, status, label, message, and timestamp', async () => {
    const { events } = await runMock();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.phase).toBe('string');
      expect(typeof event.status).toBe('string');
      expect(typeof event.label).toBe('string');
      expect(event.label.length).toBeGreaterThan(0);
      expect(typeof event.message).toBe('string');
      expect(event.message.length).toBeGreaterThan(0);
      expect(typeof event.timestamp).toBe('string');
      expect(event.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  test('mock pipeline (TN off) emits the full canonical phase set', async () => {
    const { events } = await runMock({ taskNormalizerEnabled: false });
    const expected: PipelineEventPhase[] = [
      'task_normalizer_skipped',
      'scan_started',
      'run_created',
      'run_directory_ready',
      'scanner_config_written',
      'scan_completed',
      'codegraph_detect_started',
      'codegraph_detect_completed',
      'codegraph_detect_only',
      'flash_input_started',
      'flash_input_built',
      'provider_resolved',
      'flash_request_started',
      'flash_request_completed',
      'flash_output_parsed',
      'flash_output_meta_written',
      'context_pack_written',
      'final_prompt_rendered',
      'run_completed',
    ];
    const seen = new Set(phases(events));
    for (const phase of expected) {
      expect(seen.has(phase)).toBe(true);
    }
  });

  test('TN off emits task_normalizer_skipped with status skipped and NOT task_normalizer_started', async () => {
    const { events } = await runMock({ taskNormalizerEnabled: false });
    const skipped = events.find((e) => e.phase === 'task_normalizer_skipped');
    expect(skipped).toBeTruthy();
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.label).toBe('Task Normalizer');
    expect(phases(events)).not.toContain('task_normalizer_started');
    expect(phases(events)).not.toContain('task_normalizer_completed');
  });

  test('TN on (mock) emits task_normalizer_started and either completed or fallback', async () => {
    // In mock mode the normalizer has no provider, so it returns a fallback intent.
    const { events } = await runMock({ taskNormalizerEnabled: true });
    expect(phases(events)).toContain('task_normalizer_started');
    const tail = events.filter((e) => e.phase === 'task_normalizer_completed' || e.phase === 'task_normalizer_fallback');
    expect(tail.length).toBeGreaterThan(0);
    if (tail[0].phase === 'task_normalizer_fallback') {
      expect(tail[0].status).toBe('warning');
    } else {
      expect(tail[0].status).toBe('completed');
    }
  });

  test('codegraph detect-only emits completed with skipped detect-only marker', async () => {
    const { events } = await runMock();
    const completed = events.find((e) => e.phase === 'codegraph_detect_completed');
    const skipped = events.find((e) => e.phase === 'codegraph_detect_only');
    expect(completed?.status).toBe('completed');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.label).toBe('CodeGraph');
  });

  test('run_completed is the final emitted event on success', async () => {
    const { events } = await runMock();
    const lastNonStream = [...events].reverse().find((event) => event.phase !== 'flash_stream_delta');
    expect(lastNonStream?.phase).toBe('run_completed');
  });

  test('events expose elapsed_ms that is monotonically non-decreasing', async () => {
    const { events } = await runMock();
    let last = -1;
    for (const event of events) {
      expect(typeof event.elapsed_ms).toBe('number');
      const value = event.elapsed_ms ?? 0;
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
  });

  test('progress_events.jsonl artifact is written and matches emitted events', async () => {
    const { events, persistedProgressJsonl } = await runMock();
    expect(persistedProgressJsonl).toBeTruthy();
    const persisted = (persistedProgressJsonl ?? '')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PipelineEvent);
    expect(persisted.length).toBe(events.length);
    expect(phases(persisted)).toEqual(phases(events));
    for (const event of persisted) {
      expect(typeof event.status).toBe('string');
      expect(typeof event.label).toBe('string');
    }
  });

  test('exact_text_scan_completed appears when the task contains a quoted phrase', async () => {
    const { events } = await runMock({ task: 'fix the button labelled "Build context" in the composer' });
    const exact = events.find((e) => e.phase === 'exact_text_scan_completed');
    expect(exact).toBeTruthy();
    expect(exact?.status).toBe('completed');
    expect(exact?.label).toBe('Exact text scan');
  });
});

describe('pipeline warning detail events', () => {
  test('every warning string in PromptPipelineResult.warnings has a matching pipeline_warning event', async () => {
    const { events, warnings } = await runMock();
    const warningEvents = events.filter((e) => e.phase === 'pipeline_warning');
    // The set of warning event messages must match the set of warning strings,
    // and there must be one event per warning (1:1 surfacing).
    expect(warningEvents.length).toBe(warnings.length);
    for (const warning of warnings) {
      const match = warningEvents.find((e) => e.message === warning);
      expect(match).toBeTruthy();
      expect(match?.status).toBe('warning');
      expect(typeof match?.label).toBe('string');
      expect(match?.label.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('pipeline_warning events precede the pipeline_completed_with_warnings summary, which precedes run_completed', async () => {
    const { events, warnings } = await runMock();
    if (warnings.length === 0) {
      // No warnings → no pipeline_warning events, and no summary event.
      expect(events.find((e) => e.phase === 'pipeline_warning')).toBeUndefined();
      expect(events.find((e) => e.phase === 'pipeline_completed_with_warnings')).toBeUndefined();
      return;
    }
    const phasesList = phases(events);
    const firstWarning = phasesList.indexOf('pipeline_warning');
    const lastWarning = phasesList.lastIndexOf('pipeline_warning');
    const summary = phasesList.indexOf('pipeline_completed_with_warnings');
    const completed = phasesList.indexOf('run_completed');
    expect(firstWarning).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(lastWarning);
    expect(completed).toBeGreaterThan(summary);
  });

  test('persisted progress_events.jsonl contains the individual pipeline_warning events alongside the summary', async () => {
    const { persistedProgressJsonl, warnings } = await runMock();
    expect(persistedProgressJsonl).toBeTruthy();
    const persisted = (persistedProgressJsonl ?? '')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PipelineEvent);
    const persistedWarningEvents = persisted.filter((e) => e.phase === 'pipeline_warning');
    expect(persistedWarningEvents.length).toBe(warnings.length);
    for (const warning of warnings) {
      const match = persistedWarningEvents.find((e) => e.message === warning);
      expect(match).toBeTruthy();
      expect(match?.status).toBe('warning');
    }
    if (warnings.length > 0) {
      expect(persisted.some((e) => e.phase === 'pipeline_completed_with_warnings')).toBe(true);
    }
  });
});

describe('pipeline progress on flash request failure', () => {
  test('flash_request_failed warning event is emitted and pipeline_failed follows', async () => {
    const { LlmAdapterError } = await import('../../../src/adapters/llm/errors.js');
    const repoRoot = makeRepo('vibecode-pipeline-progress-fail-');
    const events: PipelineEvent[] = [];
    const adapter: LlmAdapter = {
      run: async () => {
        throw new LlmAdapterError('provider failed for progress coverage test', {
          code: 'FLASH_PROVIDER_BAD_RESPONSE',
          details: ['safe diagnostic detail'],
        });
      },
    };
    try {
      const result = await runPromptPipeline({
        task: 'fail-on-purpose progress coverage test',
        repoRoot,
        mock: false,
        adapter,
        flashProvider: 'openrouter',
        flashModel: 'progress-test-model',
        onProgress: (event) => events.push(event),
      });
      expect(result.ok).toBe(false);
      const failed = events.find((e) => e.phase === 'flash_request_failed');
      expect(failed).toBeTruthy();
      expect(failed?.status).toBe('failed');
      expect(failed?.label).toBe('Flash request');
      const pipelineFailed = events.find((e) => e.phase === 'pipeline_failed');
      expect(pipelineFailed).toBeTruthy();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
