import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { buildCompactFlashContext, buildFlashInputManifest } from '../../../src/core/context/index.js';

function makeRunFixture(): { repoRoot: string; runDir: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-flash-'));
  const runDir = path.join(repoRoot, '.vibecode', 'runs', '20260525_000001');
  fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'Implement CodeGraph context support\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify({ run_id: '20260525_000001', task: 'Implement CodeGraph context support', repo_root: repoRoot, created_at: '2026-05-25T00:00:00.000Z' }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scanner_config.json'), JSON.stringify({ repo_root: repoRoot, task: 'Implement CodeGraph context support' }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'scan_manifest.json'), JSON.stringify({ artifacts: [] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'skills', 'skills_catalog.json'), JSON.stringify({ skills: [] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'file_inventory.json'), JSON.stringify({ files: [{ path: 'src/adapters/codegraph/codegraph_context.ts' }, { path: 'tests/adapters/codegraph/context.test.ts' }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'keyword_hits.json'), JSON.stringify({ keyword_hits: [{ path: 'src/adapters/codegraph/codegraph_context.ts', match_type: 'path', excerpt: 'codegraph context' }] }), 'utf8');
  return { repoRoot, runDir };
}

describe('CodeGraph flash input integration', () => {
  test('manifest includes codegraph_context only when the bounded artifact exists', () => {
    const fixture = makeRunFixture();
    try {
      const detectOnlyManifest = buildFlashInputManifest({
        run_id: '20260525_000001',
        task: 'Implement CodeGraph context support',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
      });
      expect(detectOnlyManifest.artifacts.codegraph_context).toBeUndefined();
      expect(detectOnlyManifest.optional_inputs.codegraph_context).toBeUndefined();
      expect(detectOnlyManifest.missing_inputs).not.toContain('scan/codegraph_context.md');
      expect(detectOnlyManifest.warnings.join('\n')).not.toContain('codegraph_context');

      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_context.md'), '# CodeGraph Context\nRelevant graph output\n', 'utf8');

      const manifest = buildFlashInputManifest({
        run_id: '20260525_000001',
        task: 'Implement CodeGraph context support',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
      });

      expect(manifest.artifacts.codegraph_context).toBe('scan/codegraph_context.md');
      expect(manifest.optional_inputs.codegraph_context).toBe('scan/codegraph_context.md');
      expect(manifest.missing_inputs).not.toContain('scan/codegraph_context.md');
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  test('flash_input.md includes a bounded CodeGraph Context guidance section when used=true', () => {
    const fixture = makeRunFixture();
    try {
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_usage.json'), JSON.stringify({ mode: 'use-existing', used: true, reason: 'EXISTING_INDEX', artifact: 'scan/codegraph_context.md', warnings: [] }, null, 2), 'utf8');
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_context.md'), '# CodeGraph says\nUse src/adapters/codegraph/codegraph_context.ts\n', 'utf8');

      const result = buildCompactFlashContext({
        run_id: '20260525_000001',
        task: 'Implement CodeGraph context support',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
      });

      expect(result.flashInput).toContain('# CodeGraph Context');
      expect(result.flashInput).toContain('Source: existing local CodeGraph index');
      expect(result.flashInput).toContain('Mode: use-existing');
      expect(result.flashInput).toContain('Artifact: scan/codegraph_context.md');
      expect(result.flashInput).toContain('CodeGraph output is guidance, not source of truth');
      expect(result.flashInput).toContain('src/adapters/codegraph/codegraph_context.ts');
      expect(result.budget.included_sections).toContain('CodeGraph Context');
      expect(result.budget.full_artifacts_referenced).toContain('scan/codegraph_context.md');
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  test('flash_input.md omits CodeGraph Context section and artifact reference when usage is detect-only', () => {
    const fixture = makeRunFixture();
    try {
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_usage.json'), JSON.stringify({ mode: 'detect-only', used: false, reason: 'DETECT_ONLY', warnings: [] }, null, 2), 'utf8');

      const result = buildCompactFlashContext({
        run_id: '20260525_000001',
        task: 'Implement CodeGraph context support',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
      });

      expect(result.flashInput).not.toContain('# CodeGraph Context');
      expect(result.flashInput).not.toContain('scan/codegraph_context.md');
      expect(result.budget.included_sections).not.toContain('CodeGraph Context');
      expect(result.budget.full_artifacts_referenced).not.toContain('scan/codegraph_context.md');
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  test('flash_input.md omits CodeGraph artifact reference when use-existing is skipped', () => {
    const fixture = makeRunFixture();
    try {
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_usage.json'), JSON.stringify({ mode: 'use-existing', used: false, reason: 'CODEGRAPH_NOT_INITIALIZED', warnings: [] }, null, 2), 'utf8');

      const result = buildCompactFlashContext({
        run_id: '20260525_000001',
        task: 'Implement CodeGraph context support',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
      });

      expect(result.flashInput).not.toContain('# CodeGraph Context');
      expect(result.flashInput).not.toContain('scan/codegraph_context.md');
      expect(result.budget.included_sections).not.toContain('CodeGraph Context');
      expect(result.budget.full_artifacts_referenced).not.toContain('scan/codegraph_context.md');
    } finally {
      fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });
});
