import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { TaskIntent } from '../../../src/adapters/task_normalizer/types.js';
import type { CodeGraphContextRunner, CodeGraphReadinessProvider } from '../../../src/adapters/codegraph/codegraph_context.js';

function makeRepo(prefix = 'vibecode-context-build-task-normalizer-'): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(repoRoot, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Context-build task normalizer fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'ui', 'renderer_toggle.ts'), 'export function toggleRenderer() { return true; }\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'raw.ts'), 'export const raw = true;\n', 'utf8');
  return repoRoot;
}

function writeLiveProviderConfig(repoRoot: string): void {
  const vibecodeDir = path.join(repoRoot, '.vibecode');
  fs.mkdirSync(vibecodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(vibecodeDir, 'config.yaml'),
    [
      'version: 1',
      'providers:',
      '  localtest:',
      '    type: openai-compatible',
      '    label: Local Test Provider',
      '    base_url: http://127.0.0.1:9/v1',
      '    api_key_env: VIBECODELIGHT_CONTEXT_BUILD_TEST_KEY',
      '    models:',
      '      - id: test-normalizer-model',
      '        label: Test Normalizer Model',
      '        role: flash',
      'defaults:',
      '  flash:',
      '    provider: localtest',
      '    model: test-normalizer-model',
      '',
    ].join('\n'),
    'utf8',
  );
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

async function loadRunContextBuild() {
  return (await import('../../../src/app/cli/index.js')).runContextBuild;
}

const ENABLED_INTENT: TaskIntent = {
  enabled: true,
  ok: true,
  source: 'llm',
  original_task: 'Přepni renderer panel',
  original_language: 'cs',
  normalized_english_task: 'Toggle the renderer panel behavior',
  search_hints: ['renderer', 'toggle'],
  keyword_groups: {
    core_terms: ['toggle'],
    ui_terms: ['renderer'],
    persistence_terms: [],
    cli_terms: [],
    test_terms: [],
  },
  negative_constraints: ['do not change desktop wiring'],
  validation_hints: ['pnpm test'],
  uncertainties: [],
  warnings: [],
  model: {
    provider: 'localtest',
    model: 'test-normalizer-model',
    live: true,
  },
};

const readyProvider: CodeGraphReadinessProvider = async () => ({
  ok: true,
  available: true,
  initialized: true,
  version: 'codegraph-test 1.0.0',
  warnings: [],
});

function captureCodeGraphTaskRunner(captured: { task: string }): CodeGraphContextRunner {
  return (_command, args) => {
    if (args[0] === 'status') {
      return { ok: true, stdout: JSON.stringify({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'context') {
      captured.task = args[1] ?? '';
      return {
        ok: true,
        stdout: ['### Entry Points', '- src/ui/renderer_toggle.ts: toggleRenderer:1'].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    return { ok: false, stdout: '', stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
  };
}

describe('context-build Task Normalizer pipeline wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../../src/adapters/task_normalizer/index.js');
    vi.resetModules();
    delete process.env.VIBECODELIGHT_CONTEXT_BUILD_TEST_KEY;
  });

  test('context-build passes provider config and model info to provider-backed normalizer', async () => {
    const repoRoot = makeRepo();
    writeLiveProviderConfig(repoRoot);
    process.env.VIBECODELIGHT_CONTEXT_BUILD_TEST_KEY = 'test-key';
    let capturedInput: Record<string, unknown> | undefined;

    vi.doMock('../../../src/adapters/task_normalizer/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/task_normalizer/index.js')>(
        '../../../src/adapters/task_normalizer/index.js',
      );
      return {
        ...actual,
        runTaskNormalizer: vi.fn(async (input: Record<string, unknown>) => {
          capturedInput = input;
          return ENABLED_INTENT;
        }),
      };
    });

    try {
      const runContextBuild = await loadRunContextBuild();
      const result = await runContextBuild({
        task: 'Přepni renderer panel',
        repoRoot,
        taskNormalizerEnabled: true,
      });

      expect(result.status).toBe('ok');
      expect(capturedInput).toBeDefined();
      expect(capturedInput?.enabled).toBe(true);
      expect(capturedInput?.providerConfig).toEqual(expect.objectContaining({
        provider: 'localtest',
        model: 'test-normalizer-model',
        apiKey: 'test-key',
      }));
      expect(capturedInput?.modelInfo).toEqual({ provider: 'localtest', model: 'test-normalizer-model' });
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const taskIntent = readJson<TaskIntent>(path.join(result.runDir, 'task_intent.json'));
      expect(taskIntent.ok).toBe(true);
      expect(taskIntent.normalized_english_task).toBe('Toggle the renderer panel behavior');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('context-build records missing provider fallback and still writes matching flash input', async () => {
    const repoRoot = makeRepo('vibecode-context-build-task-normalizer-fallback-');
    try {
      const runContextBuild = await loadRunContextBuild();
      const result = await runContextBuild({
        task: 'Přepni renderer panel',
        repoRoot,
        taskNormalizerEnabled: true,
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const taskIntent = readJson<TaskIntent>(path.join(result.runDir, 'task_intent.json'));
      expect(taskIntent.enabled).toBe(true);
      expect(taskIntent.ok).toBe(false);
      expect(taskIntent.source).toBe('fallback');
      expect((result.warnings ?? []).join('\n')).toContain('Task normalizer enabled but no providerConfig was resolved');

      const flashInput = fs.readFileSync(path.join(result.runDir, 'flash', 'flash_input.md'), 'utf8');
      expect(flashInput).toContain('## Task Intent');
      expect(flashInput).toContain('Task Normalizer: fallback (failed)');
      expect(flashInput).toContain('Using raw user task only.');
      expect(flashInput).not.toContain('Task Normalizer: off');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('context-build propagates successful task intent into flash_input.md and task_slice.md', async () => {
    const repoRoot = makeRepo();
    vi.doMock('../../../src/adapters/task_normalizer/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/task_normalizer/index.js')>(
        '../../../src/adapters/task_normalizer/index.js',
      );
      return {
        ...actual,
        runTaskNormalizer: vi.fn(async () => ENABLED_INTENT),
      };
    });

    try {
      const runContextBuild = await loadRunContextBuild();
      const result = await runContextBuild({
        task: 'Přepni renderer panel',
        repoRoot,
        taskNormalizerEnabled: true,
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const taskIntent = readJson<TaskIntent>(path.join(result.runDir, 'task_intent.json'));
      expect(taskIntent.ok).toBe(true);

      const flashInput = fs.readFileSync(path.join(result.runDir, 'flash', 'flash_input.md'), 'utf8');
      const taskSlice = fs.readFileSync(path.join(result.runDir, 'flash', 'task_slice.md'), 'utf8');
      for (const content of [flashInput, taskSlice]) {
        expect(content).toContain('## Task Intent');
        expect(content).toContain('Task Normalizer: on');
        expect(content).toContain('Normalized English task:');
        expect(content).toContain('Toggle the renderer panel behavior');
        expect(content).toContain('- renderer');
        expect(content).toContain('- toggle');
      }
      expect(flashInput).not.toContain('Task Normalizer: off');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('context-build enriches CodeGraph task when normalizer succeeds', async () => {
    const repoRoot = makeRepo();
    const captured = { task: '' };
    vi.doMock('../../../src/adapters/task_normalizer/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/adapters/task_normalizer/index.js')>(
        '../../../src/adapters/task_normalizer/index.js',
      );
      return {
        ...actual,
        runTaskNormalizer: vi.fn(async () => ENABLED_INTENT),
      };
    });

    try {
      const runContextBuild = await loadRunContextBuild();
      const result = await runContextBuild({
        task: 'Přepni renderer panel',
        repoRoot,
        taskNormalizerEnabled: true,
        codegraphMode: 'use-existing',
        codegraphRunner: captureCodeGraphTaskRunner(captured),
        codegraphReadinessProvider: readyProvider,
      });

      expect(result.status).toBe('ok');
      expect(captured.task).toContain('Original task:\nPřepni renderer panel');
      expect(captured.task).toContain('Normalized task:\nToggle the renderer panel behavior');
      expect(captured.task).toContain('Search hints:\n- renderer\n- toggle');
      expect(captured.task).toContain('Constraints:\n- do not change desktop wiring');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('context-build sends raw CodeGraph task when normalizer is disabled', async () => {
    const repoRoot = makeRepo();
    const captured = { task: '' };
    try {
      const runContextBuild = await loadRunContextBuild();
      const result = await runContextBuild({
        task: 'raw context-build task',
        repoRoot,
        taskNormalizerEnabled: false,
        codegraphMode: 'use-existing',
        codegraphRunner: captureCodeGraphTaskRunner(captured),
        codegraphReadinessProvider: readyProvider,
      });

      expect(result.status).toBe('ok');
      expect(captured.task).toBe('raw context-build task');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      const taskIntent = readJson<TaskIntent>(path.join(result.runDir, 'task_intent.json'));
      expect(taskIntent.enabled).toBe(false);
      const flashInput = fs.readFileSync(path.join(result.runDir, 'flash', 'flash_input.md'), 'utf8');
      expect(flashInput).toContain('## Task Intent');
      expect(flashInput).toContain('Task Normalizer: off');
      expect(flashInput).toContain('Using raw user task only.');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
