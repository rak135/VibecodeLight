import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, test } from 'vitest';

import { runContextBuild } from '../../../src/app/cli/index.js';
import type { CodeGraphContextRunner, CodeGraphReadinessProvider } from '../../../src/adapters/codegraph/codegraph_context.js';

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-pipeline-'));
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# CodeGraph pipeline fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export function main() { return "ok"; }\n', 'utf8');
  return repoRoot;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const readyProvider: CodeGraphReadinessProvider = async () => ({
  ok: true,
  available: true,
  initialized: true,
  version: 'codegraph-test 1.0.0',
  warnings: [],
});

function successRunner(): CodeGraphContextRunner {
  return (_command, args) => {
    if (args[0] === 'status') {
      return { ok: true, stdout: JSON.stringify({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'context') {
      return {
        ok: true,
        stdout: [
          '### Entry Points',
          '- src/index.ts: main:1',
          '',
          '### Related Symbols',
          '- **main** (function) - src/index.ts:1',
          '',
          'Raw details mention src/raw/large_dump.ts but the atlas should keep flash_input compact.',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    return { ok: false, stdout: '', stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
  };
}

function failureRunner(): CodeGraphContextRunner {
  return (_command, args) => {
    if (args[0] === 'status') {
      return { ok: true, stdout: JSON.stringify({ pendingChanges: { added: 0, modified: 0, removed: 0 } }), stderr: '', exitCode: 0 };
    }
    return { ok: false, stdout: '', stderr: 'connection refused', exitCode: 1 };
  };
}

describe('CodeGraph context-build pipeline integration', () => {
  test('detect-only records non-use and does not inject CodeGraph artifacts into flash_input.md', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({ task: 'inspect detect only path', repoRoot, codegraphMode: 'detect-only' });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);

      const usagePath = path.join(result.runDir, 'scan', 'codegraph_usage.json');
      expect(fs.existsSync(usagePath)).toBe(true);
      const usage = readJson(usagePath);
      expect(usage.used).toBe(false);
      expect(usage.reason).toBe('DETECT_ONLY');
      expect(usage.repo_atlas_generated).toBe(false);
      expect(usage.codegraph_repo_atlas_generated).toBe(false);

      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_context.md'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_repo_atlas.md'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_repo_atlas.json'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'repo_atlas.md'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'repo_atlas.json'))).toBe(false);

      const flashInput = fs.readFileSync(path.join(result.runDir, 'flash', 'flash_input.md'), 'utf8');
      expect(flashInput).not.toContain('CodeGraph-Derived Repo Atlas');
      expect(flashInput).not.toContain('# CodeGraph Context');
      expect(flashInput).not.toContain('scan/codegraph_context.md');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing success writes CodeGraph artifacts and references compact atlas before raw context', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({
        task: 'inspect use existing path',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphRunner: successRunner(),
        codegraphReadinessProvider: readyProvider,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);

      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.used).toBe(true);
      expect(usage.codegraph_repo_atlas_generated).toBe(true);
      expect(usage.codegraph_repo_atlas_artifact).toBe('scan/codegraph_repo_atlas.md');
      expect(usage.codegraph_repo_atlas_json_artifact).toBe('scan/codegraph_repo_atlas.json');

      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_context.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_repo_atlas.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_repo_atlas.json'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'repo_atlas.md'))).toBe(true);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'repo_atlas.json'))).toBe(true);

      const flashInput = fs.readFileSync(path.join(result.runDir, 'flash', 'flash_input.md'), 'utf8');
      expect(flashInput).toContain('CodeGraph-Derived Repo Atlas');
      expect(flashInput).toContain('Artifact: scan/codegraph_repo_atlas.md');
      expect(flashInput).toContain('# CodeGraph Context');
      expect(flashInput).toContain('Full CodeGraph context remains available at scan/codegraph_context.md');
      expect(flashInput).not.toContain('src/raw/large_dump.ts');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('use-existing context failure is non-fatal and omits CodeGraph context from flash_input.md', async () => {
    const repoRoot = makeRepo();
    try {
      const result = await runContextBuild({
        task: 'inspect failure path',
        repoRoot,
        codegraphMode: 'use-existing',
        codegraphRunner: failureRunner(),
        codegraphReadinessProvider: readyProvider,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.diagnostic);
      expect((result.warnings ?? []).join('\n')).toContain('CODEGRAPH_CONTEXT_FAILED');

      const usage = readJson(path.join(result.runDir, 'scan', 'codegraph_usage.json'));
      expect(usage.mode).toBe('use-existing');
      expect(usage.used).toBe(false);
      expect(usage.reason).toBe('CODEGRAPH_CONTEXT_FAILED');
      expect(usage.error).toEqual(expect.objectContaining({ code: 'CODEGRAPH_CONTEXT_FAILED' }));
      expect(usage.codegraph_repo_atlas_generated).toBe(false);

      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_context.md'))).toBe(false);
      expect(fs.existsSync(path.join(result.runDir, 'scan', 'codegraph_repo_atlas.md'))).toBe(false);

      const flashInput = fs.readFileSync(path.join(result.runDir, 'flash', 'flash_input.md'), 'utf8');
      expect(flashInput).not.toContain('CodeGraph-Derived Repo Atlas');
      expect(flashInput).not.toContain('# CodeGraph Context');
      expect(fs.existsSync(path.join(result.runDir, 'flash', 'flash_input.md'))).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
