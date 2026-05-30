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
      expect(detectOnlyManifest.artifacts.repo_atlas).toBeUndefined();
      expect(detectOnlyManifest.optional_inputs.repo_atlas).toBeUndefined();
      expect(detectOnlyManifest.artifacts.repo_atlas_json).toBeUndefined();
      expect(detectOnlyManifest.optional_inputs.repo_atlas_json).toBeUndefined();
      expect(detectOnlyManifest.missing_inputs).not.toContain('scan/codegraph_context.md');
      expect(detectOnlyManifest.missing_inputs).not.toContain('scan/codegraph_repo_atlas.md');
      expect(detectOnlyManifest.missing_inputs).not.toContain('scan/codegraph_repo_atlas.json');
      expect(detectOnlyManifest.warnings.join('\n')).not.toContain('codegraph_context');
      expect(detectOnlyManifest.warnings.join('\n')).not.toContain('repo_atlas');

      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_context.md'), '# CodeGraph Context\nRelevant graph output\n', 'utf8');
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_repo_atlas.md'), '# Repo Atlas\nCompact graph hints\n', 'utf8');
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_repo_atlas.json'), JSON.stringify({ generated: true }), 'utf8');

      const manifest = buildFlashInputManifest({
        run_id: '20260525_000001',
        task: 'Implement CodeGraph context support',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
      });

      expect(manifest.optional_inputs.repo_atlas).toBe('scan/codegraph_repo_atlas.md');
      expect(manifest.optional_inputs.repo_atlas_json).toBe('scan/codegraph_repo_atlas.json');
      expect(manifest.optional_inputs.codegraph_context).toBe('scan/codegraph_context.md');
      expect(Object.keys(manifest.optional_inputs).indexOf('repo_atlas')).toBeLessThan(Object.keys(manifest.optional_inputs).indexOf('codegraph_context'));
      expect(Object.keys(manifest.artifacts).indexOf('repo_atlas')).toBeLessThan(Object.keys(manifest.artifacts).indexOf('codegraph_context'));
      expect(manifest.artifacts.repo_atlas).toBe('scan/codegraph_repo_atlas.md');
      expect(manifest.optional_inputs.repo_atlas).toBe('scan/codegraph_repo_atlas.md');
      expect(manifest.artifacts.repo_atlas_json).toBe('scan/codegraph_repo_atlas.json');
      expect(manifest.optional_inputs.repo_atlas_json).toBe('scan/codegraph_repo_atlas.json');
      expect(manifest.missing_inputs).not.toContain('scan/codegraph_context.md');
      expect(manifest.missing_inputs).not.toContain('scan/codegraph_repo_atlas.md');
      expect(manifest.missing_inputs).not.toContain('scan/codegraph_repo_atlas.json');
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

  test('flash_input.md includes CodeGraph-derived Repo Atlas before raw CodeGraph artifact reference when generated', () => {
    const fixture = makeRunFixture();
    try {
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_usage.json'), JSON.stringify({
        mode: 'use-existing',
        used: true,
        reason: 'EXISTING_INDEX',
        artifact: 'scan/codegraph_context.md',
        codegraph_repo_atlas_generated: true,
        codegraph_repo_atlas_artifact: 'scan/codegraph_repo_atlas.md',
        codegraph_repo_atlas_json_artifact: 'scan/codegraph_repo_atlas.json',
        repo_atlas_generated: true,
        repo_atlas_artifact: 'scan/repo_atlas.md',
        repo_atlas_json_artifact: 'scan/repo_atlas.json',
        warnings: [],
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_context.md'), '# CodeGraph says\nRaw details mention src/raw/large_dump.ts\n', 'utf8');
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_repo_atlas.md'), [
        '# Repo Atlas',
        'Important note: CodeGraph output is guidance, not source of truth.',
        '## Likely Relevant Areas',
        '- src/core/context/flash_compaction.ts — CodeGraph-derived hint',
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(fixture.runDir, 'scan', 'codegraph_repo_atlas.json'), JSON.stringify({ generated: true }), 'utf8');

      const result = buildCompactFlashContext({
        run_id: '20260525_000001',
        task: 'Implement CodeGraph context support',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
      });

      const repoAtlasIndex = result.flashInput.indexOf('# Repo Atlas');
      const codeGraphIndex = result.flashInput.indexOf('# CodeGraph Context');
      expect(repoAtlasIndex).toBeGreaterThanOrEqual(0);
      expect(codeGraphIndex).toBeGreaterThan(repoAtlasIndex);
      expect(result.flashInput).toContain('## CodeGraph-Derived Repo Atlas');
      expect(result.flashInput).toContain('src/core/context/flash_compaction.ts');
      expect(result.flashInput).toContain('Full CodeGraph context remains available at scan/codegraph_context.md');
      expect(result.flashInput).not.toContain('src/raw/large_dump.ts');
      expect(result.budget.full_artifacts_referenced).toContain('scan/codegraph_repo_atlas.md');
      expect(result.budget.full_artifacts_referenced).toContain('scan/codegraph_repo_atlas.json');
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
