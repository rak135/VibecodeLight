import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

function runCli(args: string[]) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'vibecode.js'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function makeRepoWithRun(opts: {
  used: boolean;
  reason: string;
  withContext?: boolean;
  withRepoAtlas?: boolean;
  withRepoAtlasJson?: boolean;
  warnings?: string[];
}): { repo: string; runId: string; runDir: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-cg-cli-'));
  const runId = '20260530-120000-CG01';
  const runDir = path.join(repo, '.vibecode', 'runs', runId);
  const scanDir = path.join(runDir, 'scan');
  fs.mkdirSync(scanDir, { recursive: true });
  fs.mkdirSync(path.join(repo, '.vibecode', 'current'), { recursive: true });
  const manifest = {
    run_id: runId,
    task: 'codegraph cli fixture',
    repo_root: repo,
    created_at: '2026-05-30T12:00:00.000Z',
    status: 'done',
  };
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(repo, '.vibecode', 'current', 'run_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(scanDir, 'external_tools.json'),
    `${JSON.stringify({
      tools: {
        codegraph: {
          available: true,
          initialized: true,
          mode: opts.used ? 'use-existing' : 'detect-only',
          used_for_context: opts.used,
          warnings: [],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(scanDir, 'codegraph_usage.json'),
    `${JSON.stringify({
      mode: opts.used ? 'use-existing' : 'detect-only',
      used: opts.used,
      reason: opts.reason,
      ...(opts.withContext ? { artifact: 'scan/codegraph_context.md' } : {}),
      repo_atlas_generated: Boolean(opts.withRepoAtlas),
      repo_atlas_reason: opts.withRepoAtlas ? 'generated' : opts.reason,
      ...(opts.withRepoAtlas ? { repo_atlas_artifact: 'scan/repo_atlas.md' } : {}),
      ...(opts.withRepoAtlasJson ? { repo_atlas_json_artifact: 'scan/repo_atlas.json' } : {}),
      warnings: opts.warnings ?? [],
    }, null, 2)}\n`,
    'utf8',
  );
  if (opts.withContext) fs.writeFileSync(path.join(scanDir, 'codegraph_context.md'), '# CodeGraph context\n', 'utf8');
  if (opts.withRepoAtlas) fs.writeFileSync(path.join(scanDir, 'repo_atlas.md'), '# Repo atlas\n', 'utf8');
  if (opts.withRepoAtlasJson) fs.writeFileSync(path.join(scanDir, 'repo_atlas.json'), '{"ok":true}\n', 'utf8');
  return { repo, runId, runDir };
}

describe('runs show CodeGraph visibility', () => {
  test('human output shows used=true CodeGraph summary and artifacts', () => {
    const fixture = makeRepoWithRun({
      used: true,
      reason: 'EXISTING_INDEX',
      withContext: true,
      withRepoAtlas: true,
      withRepoAtlasJson: true,
      warnings: ['CODEGRAPH_INDEX_STALE: fixture'],
    });
    try {
      const result = runCli(['runs', 'show', 'latest', '--repo', fixture.repo]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('CodeGraph:');
      expect(result.stdout).toContain('status: ready');
      expect(result.stdout).toContain('mode: use-existing');
      expect(result.stdout).toContain('used for context: yes');
      expect(result.stdout).toContain('reason: existing index');
      expect(result.stdout).toContain('repo atlas: generated');
      expect(result.stdout).toContain('scan/codegraph_usage.json');
      expect(result.stdout).toContain('scan/codegraph_context.md');
      expect(result.stdout).toContain('scan/repo_atlas.md');
      expect(result.stdout).toContain('scan/repo_atlas.json');
      expect(result.stdout).toContain('Index may be stale. Existing index was used. Run Sync to update it.');
    } finally {
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  test('json output exposes the shared structured codegraph object', () => {
    const fixture = makeRepoWithRun({ used: true, reason: 'EXISTING_INDEX', withContext: true });
    try {
      const result = runCli(['runs', 'show', 'latest', '--repo', fixture.repo, '--json']);
      expect(result.status).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.codegraph.usedForContext).toBe(true);
      expect(envelope.data.codegraph.usageReason).toBe('existing index');
      expect(Object.keys(envelope.data.codegraph).sort()).toEqual([
        'contextArtifact',
        'detail',
        'displayWarnings',
        'label',
        'mode',
        'repoAtlasGenerated',
        'repoAtlasNote',
        'repoAtlasReason',
        'state',
        'usageNote',
        'usageReason',
        'usedForContext',
        'warnings',
      ]);
    } finally {
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  test('human output explains detect-only used=false runs', () => {
    const fixture = makeRepoWithRun({ used: false, reason: 'DETECT_ONLY' });
    try {
      const result = runCli(['runs', 'show', 'latest', '--repo', fixture.repo]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('used for context: no');
      expect(result.stdout).toContain('reason: detect-only');
      expect(result.stdout).toContain('usage note: CodeGraph used: no — detect-only.');
    } finally {
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  test('artifact read supports CodeGraph alias and explicit scan artifacts', () => {
    const fixture = makeRepoWithRun({ used: true, reason: 'EXISTING_INDEX', withContext: true, withRepoAtlas: true });
    try {
      const alias = runCli(['runs', 'show', 'latest', '--repo', fixture.repo, '--artifact', 'codegraph']);
      expect(alias.status).toBe(0);
      expect(alias.stdout).toContain('"used": true');

      const atlas = runCli(['runs', 'show', 'latest', '--repo', fixture.repo, '--artifact', 'scan/repo_atlas.md']);
      expect(atlas.status).toBe(0);
      expect(atlas.stdout).toContain('# Repo atlas');
    } finally {
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});
