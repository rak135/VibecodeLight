import fs from 'fs';
import os from 'os';
import path from 'path';

import type { LlmAdapter } from '../../../src/adapters/llm/base.js';
import { LlmAdapterError } from '../../../src/adapters/llm/errors.js';
import { OpenAiCompatibleAdapter } from '../../../src/adapters/llm/openai_compatible_adapter.js';
import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';
import type { PipelineEvent, PipelineEventPhase } from '../../../src/core/prompting/pipeline_events.js';

const SECRET_API_KEY = 'secret-api-key-progress-event-test';

const VALID_FLASH_MARKDOWN = [
  '# Task Summary',
  'Progress event fake live flash output for pipeline tests.',
  '',
  '# Relevant Files',
  '- README.md — fixture repository overview',
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
  '- test-driven-development — validate progress event contract before implementation',
  '',
  '# Cautions',
  '- progress event test fixture only; do not treat as model guidance',
  '',
  '# Context Pack',
  'This live flash context pack is deterministic for progress event tests.',
  '',
].join('\n');

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-pipeline-events-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

function fakeLiveFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: VALID_FLASH_MARKDOWN } }] }),
  } as Response);
}

async function runMockPipelineWithEvents(): Promise<{ events: PipelineEvent[]; finalPromptPath: string }> {
  const repoRoot = makeRepo();
  const events: PipelineEvent[] = [];

  try {
    const result = await runPromptPipeline({
      task: 'mock progress event pipeline test',
      repoRoot,
      mock: true,
      onProgress: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return { events, finalPromptPath: result.finalPromptPath };
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runLivePipelineWithEvents(): Promise<PipelineEvent[]> {
  const repoRoot = makeRepo();
  const events: PipelineEvent[] = [];
  const adapter = new OpenAiCompatibleAdapter(
    {
      provider: 'openrouter',
      apiKey: SECRET_API_KEY,
      baseUrl: 'https://api.example.com/v1',
      model: 'progress-test-model',
      live: true,
    },
    fakeLiveFetch() as typeof fetch,
  );

  try {
    const result = await runPromptPipeline({
      task: 'fake live progress event pipeline test',
      repoRoot,
      mock: false,
      adapter,
      flashProvider: 'openrouter',
      flashModel: 'progress-test-model',
      onProgress: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return events;
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function expectPhase(events: PipelineEvent[], phase: PipelineEventPhase): PipelineEvent {
  const event = events.find((candidate) => candidate.phase === phase);
  expect(event).toBeTruthy();
  return event as PipelineEvent;
}

describe('prompt pipeline progress events', () => {
  test('pipeline emits scan_started event', async () => {
    const { events } = await runMockPipelineWithEvents();
    expectPhase(events, 'scan_started');
  });

  test('pipeline emits scan_completed event', async () => {
    const { events } = await runMockPipelineWithEvents();
    expectPhase(events, 'scan_completed');
  });

  test('pipeline emits flash_input_built event', async () => {
    const { events } = await runMockPipelineWithEvents();
    expectPhase(events, 'flash_input_built');
  });

  test("pipeline emits provider_resolved event for mock with provider_id='mock'", async () => {
    const { events } = await runMockPipelineWithEvents();
    expect(expectPhase(events, 'provider_resolved')).toMatchObject({ provider_id: 'mock' });
  });

  test('pipeline emits flash_request_started event', async () => {
    const { events } = await runMockPipelineWithEvents();
    expectPhase(events, 'flash_request_started');
  });

  test('pipeline emits flash_response_received event', async () => {
    const { events } = await runMockPipelineWithEvents();
    expectPhase(events, 'flash_response_received');
  });

  test('pipeline emits flash_output_validated event', async () => {
    const { events } = await runMockPipelineWithEvents();
    expectPhase(events, 'flash_output_validated');
  });

  test('pipeline emits context_pack_written event', async () => {
    const { events } = await runMockPipelineWithEvents();
    expectPhase(events, 'context_pack_written');
  });

  test('pipeline emits final_prompt_written event with artifact_path', async () => {
    const { events, finalPromptPath } = await runMockPipelineWithEvents();
    expect(expectPhase(events, 'final_prompt_written')).toMatchObject({ artifact_path: finalPromptPath });
  });

  test('events are emitted in order', async () => {
    const { events } = await runMockPipelineWithEvents();
    const phases = events.map((event) => event.phase);
    const expectedOrder: PipelineEventPhase[] = [
      'scan_started',
      'run_created',
      'scan_completed',
      'flash_input_built',
      'provider_resolved',
      'flash_request_started',
      'flash_response_received',
      'flash_output_validated',
      'context_pack_written',
      'final_prompt_written',
    ];

    for (const phase of expectedOrder) {
      expect(phases).toContain(phase);
    }
    for (let index = 1; index < expectedOrder.length; index += 1) {
      expect(phases.indexOf(expectedOrder[index - 1])).toBeLessThan(phases.indexOf(expectedOrder[index]));
    }
  });

  test('provider_resolved event does NOT include api key', async () => {
    const events = await runLivePipelineWithEvents();
    const event = expectPhase(events, 'provider_resolved');

    expect(event).toMatchObject({ provider_id: 'openrouter', model_id: 'progress-test-model' });
    expect(JSON.stringify(event)).not.toContain(SECRET_API_KEY);
    expect(event).not.toHaveProperty('apiKey');
    expect(event).not.toHaveProperty('api_key');
  });

  test('failed event is emitted on provider bad response', async () => {
    const repoRoot = makeRepo();
    const events: PipelineEvent[] = [];
    const adapter: LlmAdapter = {
      run: async () => {
        throw new LlmAdapterError('provider bad response for progress event test', {
          code: 'FLASH_PROVIDER_BAD_RESPONSE',
          details: ['safe diagnostic detail'],
        });
      },
    };

    try {
      const result = await runPromptPipeline({
        task: 'failing provider progress event pipeline test',
        repoRoot,
        mock: false,
        adapter,
        flashProvider: 'openrouter',
        flashModel: 'progress-test-model',
        onProgress: (event) => events.push(event),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FLASH_PROVIDER_BAD_RESPONSE');
      expect(expectPhase(events, 'failed').message).toContain('FLASH_PROVIDER_BAD_RESPONSE');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('all events have phase and message fields', async () => {
    const { events } = await runMockPipelineWithEvents();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.phase).toEqual(expect.any(String));
      expect(event.message).toEqual(expect.any(String));
      expect(event.message.length).toBeGreaterThan(0);
    }
  });

  test('elapsed_ms is a non-negative number', async () => {
    const { events } = await runMockPipelineWithEvents();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.elapsed_ms).toEqual(expect.any(Number));
      expect(event.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
  });
});
