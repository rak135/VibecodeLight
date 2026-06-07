import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';
import { afterEach, describe, expect, test } from 'vitest';

import type {
  CodeGraphContextRunner,
  CodeGraphReadinessProvider,
} from '../../../src/adapters/codegraph/codegraph_context.js';
import type { CodeGraphMcpContextRunner } from '../../../src/adapters/codegraph/codegraph_mcp.js';
import { performContextBuildPhase } from '../../../src/core/runs/context_build_phase.js';

/**
 * TEMPORARY: Pins CodeGraph artifact surface for context-build phase.
 * Should be consolidated into codegraph_step_parity.test.ts as the single
 * canonical CodeGraph artifact test. Remove artifact-list assertions when
 * codegraph_step_parity.test.ts is the sole canonical test.
 * Do not add new assertions here.
 */

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Context-build CodeGraph characterization fixture\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export function main() { return "ok"; }\n', 'utf8');
  return repoRoot;
}

function makeAppDataWithTransport(transport: 'cli' | 'mcp' | 'auto'): string {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-context-cg-appdata-'));
  const dir = path.join(appData, 'vibecodelight');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    YAML.stringify({ version: 1, defaults: { codegraph: { transport }, flash: {} }, providers: {} }),
    'utf8',
  );
  return appData;
}

function toRelativeArtifacts(runDir: string, artifacts: string[] = []): string[] {
  return artifacts.map((artifact) => path.relative(runDir, artifact).replace(/\\/g, '/'));
}

function readUsage(runDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'scan', 'codegraph_usage.json'), 'utf8')) as Record<string, unknown>;
}

const readyProvider: CodeGraphReadinessProvider = async () => ({
  ok: true,
  available: true,
  initialized: true,
  version: 'codegraph-test 1.0.0',
  warnings: [],
});

const cliFailureRunner: CodeGraphContextRunner = (_command, args) => {
  if (args[0] === 'status') {
    return { ok: true, stdout: JSON.stringify({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: '', exitCode: 0 };
  }
  return { ok: false, stdout: '', stderr: 'cli context failed for characterization', exitCode: 1 };
};

const throwingRunner: CodeGraphContextRunner = () => {
  throw new Error('runner exploded for characterization');
};

const mcpSuccessRunner: CodeGraphMcpContextRunner = async () => ({
  ok: true,
  text: [
    '### Entry Points',
    '- src/index.ts: main:1',
    '',
    '### Related Symbols',
    '- **main** (function) - src/index.ts:1',
  ].join('\n'),
});

describe('context-build CodeGraph characterization', () => {
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const cleanup: string[] = [];

  afterEach(() => {
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  test('use-existing success reports canonical and legacy CodeGraph artifacts in result.artifacts', async () => {
    const repoRoot = makeRepo('vibecode-context-cg-artifacts-');
    cleanup.push(repoRoot);

    const result = await performContextBuildPhase({
      task: 'characterize context-build CodeGraph artifacts',
      repoRoot,
      codegraphMode: 'use-existing',
      codegraphTransport: 'mcp',
      codegraphMcpRunner: mcpSuccessRunner,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.diagnostic);

    const relativeArtifacts = toRelativeArtifacts(result.runDir, result.artifacts);
    expect(relativeArtifacts).toEqual(expect.arrayContaining([
      'scan/codegraph_usage.json',
      'scan/codegraph_context.md',
      'scan/codegraph_repo_atlas.md',
      'scan/codegraph_repo_atlas.json',
      'scan/repo_atlas.md',
      'scan/repo_atlas.json',
    ]));

    for (const relativePath of [
      'scan/codegraph_usage.json',
      'scan/codegraph_context.md',
      'scan/codegraph_repo_atlas.md',
      'scan/codegraph_repo_atlas.json',
      'scan/repo_atlas.md',
      'scan/repo_atlas.json',
    ]) {
      expect(fs.existsSync(path.join(result.runDir, relativePath)), relativePath).toBe(true);
    }
  });

  test('CodeGraph warnings are flat strings in result.warnings without pipeline warning labels', async () => {
    const repoRoot = makeRepo('vibecode-context-cg-warning-');
    cleanup.push(repoRoot);

    const result = await performContextBuildPhase({
      task: 'characterize context-build CodeGraph warning shape',
      repoRoot,
      codegraphMode: 'use-existing',
      codegraphTransport: 'cli',
      codegraphRunner: cliFailureRunner,
      codegraphReadinessProvider: readyProvider,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.diagnostic);
    const warnings = result.warnings ?? [];
    expect(warnings.some((warning) => warning.includes('CODEGRAPH_CONTEXT_FAILED'))).toBe(true);
    expect(warnings.every((warning) => typeof warning === 'string')).toBe(true);
    expect(warnings).not.toContain('CodeGraph');
  });

  test('CodeGraph context build exceptions are non-fatal and recorded in usage fallback metadata', async () => {
    const repoRoot = makeRepo('vibecode-context-cg-fallback-');
    cleanup.push(repoRoot);

    const result = await performContextBuildPhase({
      task: 'characterize context-build CodeGraph throw fallback',
      repoRoot,
      codegraphMode: 'use-existing',
      codegraphTransport: 'cli',
      codegraphRunner: throwingRunner,
      codegraphReadinessProvider: readyProvider,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.diagnostic);
    expect(result.warnings?.join('\n')).toContain('CODEGRAPH_CONTEXT_FAILED: runner exploded for characterization');
    expect(readUsage(result.runDir)).toMatchObject({
      mode: 'use-existing',
      used: false,
      used_for_context: false,
      reason: 'CODEGRAPH_CONTEXT_FAILED',
      transport_requested: 'cli',
      transport_used: 'none',
      error: {
        code: 'CODEGRAPH_CONTEXT_FAILED',
        message: 'runner exploded for characterization',
      },
    });
    expect(fs.existsSync(path.join(result.runDir, 'flash', 'flash_input.md'))).toBe(true);
  });

  test('omitted codegraphTransport reads persisted environment-driven transport config', async () => {
    const repoRoot = makeRepo('vibecode-context-cg-default-');
    const appData = makeAppDataWithTransport('mcp');
    cleanup.push(repoRoot, appData);
    process.env.LOCALAPPDATA = appData;

    const result = await performContextBuildPhase({
      task: 'characterize context-build transport default',
      repoRoot,
      codegraphMode: 'use-existing',
      codegraphMcpRunner: mcpSuccessRunner,
      codegraphRunner: () => {
        throw new Error('CLI runner should not be called when persisted transport is mcp');
      },
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.diagnostic);
    expect(readUsage(result.runDir)).toMatchObject({
      mode: 'use-existing',
      transport_requested: 'mcp',
      transport_used: 'mcp',
      mcp_attempted: true,
      used_for_context: true,
    });
  });
});
