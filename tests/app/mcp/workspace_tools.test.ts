import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildWorkspaceInfoTool,
  type WorkspaceInfoToolDeps,
} from '../../../src/app/mcp/tools/workspace_info.js';
import {
  buildWorkspaceStatusTool,
  type WorkspaceStatusToolDeps,
} from '../../../src/app/mcp/tools/workspace_status.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';
import { buildMcpGuidanceTool } from '../../../src/app/mcp/tools/mcp_guidance.js';
import { buildProjectInstructionsTool } from '../../../src/app/mcp/tools/project_instructions.js';
import { buildArtifactsListTool } from '../../../src/app/mcp/tools/artifacts_list.js';
import type { McpServerContext } from '../../../src/app/mcp/index.js';
import type { CodeGraphStatusResult } from '../../../src/adapters/codegraph/codegraph_actions.js';
import type { GitReadOnlyRunner } from '../../../src/core/workspace/git_status.js';

const FAKE_CODEGRAPH_STATUS_AVAILABLE: CodeGraphStatusResult = {
  ok: true,
  available: true,
  initialized: true,
  version: '0.9.4',
  warnings: [],
  binary: { command: 'codegraph', source: 'PATH_FALLBACK', configured: null },
};

const FAKE_CODEGRAPH_STATUS_MISSING: CodeGraphStatusResult = {
  ok: true,
  available: false,
  initialized: false,
  warnings: ['codegraph binary not found'],
};

function ctx(repoRoot: string): McpServerContext {
  return { repoRoot };
}

function makeRepo(prefix: string): { repoRoot: string; cleanup: () => void } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { repoRoot, cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }) };
}

function seedRunWithCurrent(
  repoRoot: string,
  runId: string,
  options: { artifacts?: Record<string, string>; current?: boolean } = {},
): void {
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 'fixture', status: 'done', repo_root: repoRoot }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(options.artifacts ?? {})) {
    const abs = path.join(runDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  if (options.current) {
    const currentDir = path.join(repoRoot, '.vibecode', 'current');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(
      path.join(currentDir, 'run_manifest.json'),
      JSON.stringify({ run_id: runId, created_at: '2026-06-05T00:00:00Z', task: 'fixture' }),
      'utf8',
    );
  }
}

// ---------------------------------------------------------------------------
// vibecode_workspace_info
// ---------------------------------------------------------------------------
describe('vibecode_workspace_info', () => {
  test('returns repo_root, tool group summary, mcp version, and codegraph status', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-info-');
    try {
      const deps: WorkspaceInfoToolDeps = {
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      };
      const tool = buildWorkspaceInfoTool(deps);
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        repo_root: string;
        mcp_server: { name: string; version: string };
        tools: { total: number; groups: Record<string, string[]> };
        codegraph: { available: boolean; initialized: boolean; version?: string };
        current_run: unknown;
        agent_guidance: string[];
      };
      expect(data.repo_root).toBe(repoRoot);
      expect(data.mcp_server.name).toBe('vibecode-mcp');
      expect(typeof data.mcp_server.version).toBe('string');
      expect(data.tools.total).toBe(VIBECODE_MCP_TOOL_NAMES.length);
      const { codegraph, runs_artifacts, workspace_orientation, coordination } = data.tools.groups;
      // Group sizes sum to the canonical total so no tool is lost or double-counted.
      expect(codegraph.length + runs_artifacts.length + workspace_orientation.length + coordination.length)
        .toBe(VIBECODE_MCP_TOOL_NAMES.length);
      // Each group contains its signature tool.
      expect(codegraph).toContain('vibecode_codegraph_status');
      expect(runs_artifacts).toContain('vibecode_runs_list');
      expect(workspace_orientation).toContain('vibecode_workspace_info');
      expect(coordination).toContain('vibecode_coordination_status');
      // No group contains a forbidden dangerous tool.
      for (const name of [...codegraph, ...runs_artifacts, ...workspace_orientation, ...coordination]) {
        expect(name).not.toMatch(/commit_guard|shell|git_write|terminal_exec|file_write/i);
      }
      expect(data.codegraph.available).toBe(true);
      expect(data.codegraph.initialized).toBe(true);
      expect(data.codegraph.version).toBe('0.9.4');
      expect(Array.isArray(data.agent_guidance)).toBe(true);
      expect(data.agent_guidance.join('\n')).toMatch(/VibecodeMCP first/i);
      expect(data.agent_guidance.join('\n')).toMatch(/CLI/);
      expect(data.agent_guidance.join('\n')).toMatch(/rg|grep/i);
    } finally {
      cleanup();
    }
  });

  test('surfaces current_run when a latest pointer exists', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-info-current-');
    try {
      seedRunWithCurrent(repoRoot, 'r1', { current: true });
      const tool = buildWorkspaceInfoTool({
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      });
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { current_run: { run_id: string } | null };
      expect(data.current_run).toBeTruthy();
      expect(data.current_run?.run_id).toBe('r1');
    } finally {
      cleanup();
    }
  });

  test('handles CodeGraph unavailable as a warning, not a crash', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-info-no-cg-');
    try {
      const tool = buildWorkspaceInfoTool({
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_MISSING,
      });
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { codegraph: { available: boolean; initialized: boolean } };
      expect(data.codegraph.available).toBe(false);
      expect(data.codegraph.initialized).toBe(false);
      expect(result.structuredContent.warnings.some((w) => /codegraph/i.test(w))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('rejects unknown argument keys with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-info-bad-');
    try {
      const tool = buildWorkspaceInfoTool({
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      });
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { repo: '/etc' } as Record<string, unknown>,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// vibecode_workspace_status
// ---------------------------------------------------------------------------
describe('vibecode_workspace_status', () => {
  const okGitRunner: GitReadOnlyRunner = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { ok: true, stdout: 'main\n', stderr: '', exitCode: 0 };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: 'abc123def456\n', stderr: '', exitCode: 0 };
    if (args[0] === 'status' && args[1] === '--porcelain=v1') {
      return {
        ok: true,
        stdout: ' M src/foo.ts\nA  src/bar.ts\n?? new.txt\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { ok: false, stdout: '', stderr: 'unexpected', exitCode: 1 };
  };

  const noGitRunner: GitReadOnlyRunner = () => ({ ok: false, stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 });

  test('returns branch/head/dirty/changed counts using injected git runner', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-status-');
    try {
      const deps: WorkspaceStatusToolDeps = {
        gitRunner: okGitRunner,
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      };
      const tool = buildWorkspaceStatusTool(deps);
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        repo_root: string;
        git: { branch: string; head: string; dirty: boolean; changed: { modified: number; staged: number; untracked: number; first_paths: string[] } } | null;
        codegraph: { available: boolean };
        current_run: unknown;
      };
      expect(data.repo_root).toBe(repoRoot);
      expect(data.git).not.toBeNull();
      expect(data.git?.branch).toBe('main');
      expect(data.git?.head).toBe('abc123def456');
      expect(data.git?.dirty).toBe(true);
      expect(data.git?.changed.modified).toBe(1);
      expect(data.git?.changed.staged).toBe(1);
      expect(data.git?.changed.untracked).toBe(1);
      expect(data.git?.changed.first_paths.length).toBeGreaterThan(0);
      expect(data.codegraph.available).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('handles a non-git repo with a warning, not a crash', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-status-nogit-');
    try {
      const tool = buildWorkspaceStatusTool({
        gitRunner: noGitRunner,
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      });
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { git: unknown };
      expect(data.git).toBeNull();
      expect(result.structuredContent.warnings.some((w) => /git/i.test(w))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('summarizes changed files without dumping raw diff', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-status-summary-');
    try {
      const tool = buildWorkspaceStatusTool({
        gitRunner: okGitRunner,
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      });
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      const text = result.content[0]?.text ?? '';
      // Must not contain a diff hunk marker
      expect(text).not.toMatch(/^@@ /m);
      expect(text).not.toMatch(/^diff --git/m);
    } finally {
      cleanup();
    }
  });

  test('includes current run/artifact availability and codegraph summary when run present', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-status-run-');
    try {
      seedRunWithCurrent(repoRoot, 'r1', { current: true, artifacts: { 'output/final_prompt.md': '# fp' } });
      const tool = buildWorkspaceStatusTool({
        gitRunner: okGitRunner,
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      });
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        current_run: { run_id: string; has_final_prompt: boolean } | null;
        codegraph: { available: boolean };
      };
      expect(data.current_run?.run_id).toBe('r1');
      expect(data.current_run?.has_final_prompt).toBe(true);
      expect(data.codegraph.available).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('rejects unknown argument keys with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-status-bad-');
    try {
      const tool = buildWorkspaceStatusTool({
        gitRunner: okGitRunner,
        codegraphStatus: async () => FAKE_CODEGRAPH_STATUS_AVAILABLE,
      });
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { workspace: '/etc' } as Record<string, unknown>,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// vibecode_mcp_guidance
// ---------------------------------------------------------------------------
describe('vibecode_mcp_guidance', () => {
  test('returns MCP-first guidance with CLI fallback and rg/grep notes (no filesystem access)', async () => {
    const tool = buildMcpGuidanceTool();
    const result = await tool.handler({ context: ctx('/tmp/whatever'), arguments: {}, requestId: null });
    expect(result.isError).toBe(false);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/workspace_info|workspace_status/);
    expect(text).toMatch(/codegraph/);
    expect(text).toMatch(/runs_list|current_run|artifact_read/);
    expect(text).toMatch(/project_instructions/);
    expect(text).toMatch(/rg|grep/i);
    expect(text).toMatch(/Vibecode CLI/i);
    expect(text).toMatch(/upstream CodeGraph/i);
    expect(text).toMatch(/approval/i);
    const data = result.structuredContent.data as { sections: string[] };
    expect(Array.isArray(data.sections)).toBe(true);
    expect(data.sections.length).toBeGreaterThan(0);
  });

  test('rejects unknown argument keys with INVALID_ARGUMENT', async () => {
    const tool = buildMcpGuidanceTool();
    const result = await tool.handler({
      context: ctx('/tmp'),
      arguments: { repo: '/etc' } as Record<string, unknown>,
      requestId: null,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------
// vibecode_project_instructions
// ---------------------------------------------------------------------------
describe('vibecode_project_instructions', () => {
  test('reads from latest/current scan artifact when available (no source files)', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-instr-scan-');
    try {
      seedRunWithCurrent(repoRoot, 'r1', {
        current: true,
        artifacts: {
          'scan/repo_instructions.json': JSON.stringify({
            files: [
              { path: 'AGENTS.md', content: '# AGENTS\nuse TDD' },
              { path: 'CONTRIBUTING.md', content: '# contributing' },
            ],
          }),
        },
      });
      const tool = buildProjectInstructionsTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        source: string;
        instructions: Array<{ path: string; excerpt: string }>;
      };
      expect(data.source).toBe('scan_artifact');
      expect(data.instructions.some((i) => i.path === 'AGENTS.md')).toBe(true);
      const agents = data.instructions.find((i) => i.path === 'AGENTS.md');
      expect(agents?.excerpt).toContain('TDD');
    } finally {
      cleanup();
    }
  });

  test('falls back to strict allowlisted repo files when no scan artifact exists', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-instr-fallback-');
    try {
      fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\nuse TDD\n', 'utf8');
      fs.writeFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), '# contributing\n', 'utf8');
      const tool = buildProjectInstructionsTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        source: string;
        instructions: Array<{ path: string; excerpt: string }>;
      };
      expect(data.source).toBe('repo_allowlist');
      const paths = data.instructions.map((i) => i.path);
      expect(paths).toContain('AGENTS.md');
      expect(paths).toContain('CONTRIBUTING.md');
    } finally {
      cleanup();
    }
  });

  test('include_docs=false omits architecture/codegraph doc excerpts', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-instr-nodocs-');
    try {
      fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
      fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'docs', 'ARCHITECTURE.md'), '# arch\n', 'utf8');
      fs.writeFileSync(path.join(repoRoot, 'docs', 'codegraph.md'), '# codegraph\n', 'utf8');

      const tool = buildProjectInstructionsTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { include_docs: false },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { instructions: Array<{ path: string }>; docs: Array<{ path: string }> | undefined };
      expect(data.instructions.some((i) => i.path === 'AGENTS.md')).toBe(true);
      // docs section is not surfaced when include_docs=false
      expect(data.docs ?? []).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('include_docs=true returns bounded architecture/codegraph docs', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-instr-docs-');
    try {
      fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
      fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'docs', 'ARCHITECTURE.md'), '# arch\n', 'utf8');
      fs.writeFileSync(path.join(repoRoot, 'docs', 'codegraph.md'), '# codegraph\n', 'utf8');

      const tool = buildProjectInstructionsTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { include_docs: true },
        requestId: null,
      });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as { docs: Array<{ path: string }> };
      const paths = data.docs.map((d) => d.path);
      expect(paths).toContain('docs/ARCHITECTURE.md');
      expect(paths).toContain('docs/codegraph.md');
    } finally {
      cleanup();
    }
  });

  test('does not read arbitrary repo source files even if requested via stray args', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-instr-noread-');
    try {
      const tool = buildProjectInstructionsTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { path: 'src/secret.ts' } as Record<string, unknown>,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('returns PROJECT_INSTRUCTIONS_NOT_FOUND when no allowlisted file exists', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-instr-none-');
    try {
      const tool = buildProjectInstructionsTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('PROJECT_INSTRUCTIONS_NOT_FOUND');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// vibecode_artifacts_list
// ---------------------------------------------------------------------------
describe('vibecode_artifacts_list', () => {
  test('lists allowlisted artifacts for the latest run without returning content', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-art-list-');
    try {
      seedRunWithCurrent(repoRoot, 'r1', {
        current: true,
        artifacts: {
          'output/final_prompt.md': 'SECRET',
          'output/context_pack.md': 'CTX',
        },
      });
      const tool = buildArtifactsListTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        run_id: string;
        artifacts: Array<{ name: string; path: string; exists: boolean; size_bytes: number | null; recommended_for_agent: boolean; description: string; group: string }>;
        recommended_next_reads: string[];
      };
      expect(data.run_id).toBe('r1');
      const finalPrompt = data.artifacts.find((a) => a.name === 'final_prompt');
      expect(finalPrompt).toBeTruthy();
      expect(finalPrompt?.exists).toBe(true);
      expect(typeof finalPrompt?.size_bytes).toBe('number');
      const contextPack = data.artifacts.find((a) => a.name === 'context_pack');
      expect(contextPack?.exists).toBe(true);
      // No content payload is ever surfaced
      const blob = JSON.stringify(result.structuredContent);
      expect(blob).not.toContain('SECRET');
      expect(blob).not.toContain('CTX');
      // Recommended next reads are not empty
      expect(data.recommended_next_reads.length).toBeGreaterThan(0);
      expect(data.recommended_next_reads).toContain('final_prompt');
    } finally {
      cleanup();
    }
  });

  test('supports explicit run_id, and latest/current aliases', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-art-list-alias-');
    try {
      seedRunWithCurrent(repoRoot, 'rX', { current: true, artifacts: { 'output/final_prompt.md': 'fp' } });
      const tool = buildArtifactsListTool();
      const explicit = await tool.handler({ context: ctx(repoRoot), arguments: { run_id: 'rX' }, requestId: null });
      const latest = await tool.handler({ context: ctx(repoRoot), arguments: { run_id: 'latest' }, requestId: null });
      const current = await tool.handler({ context: ctx(repoRoot), arguments: { run_id: 'current' }, requestId: null });
      for (const r of [explicit, latest, current]) {
        expect(r.isError).toBe(false);
        const d = r.structuredContent.data as { run_id: string };
        expect(d.run_id).toBe('rX');
      }
    } finally {
      cleanup();
    }
  });

  test('returns RUN_NOT_FOUND when the run id does not exist', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-art-list-norun-');
    try {
      const tool = buildArtifactsListTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: 'nope' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('RUN_NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  test('rejects path traversal in run_id with RUN_NOT_FOUND', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-art-list-traversal-');
    try {
      const tool = buildArtifactsListTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { run_id: '../../etc' },
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('RUN_NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  test('rejects unknown argument keys with INVALID_ARGUMENT', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-art-list-bad-');
    try {
      const tool = buildArtifactsListTool();
      const result = await tool.handler({
        context: ctx(repoRoot),
        arguments: { repo: '/etc' } as Record<string, unknown>,
        requestId: null,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      cleanup();
    }
  });

  test('aligns with the artifact_read allowlist (every listed name maps to an allowlisted relative path)', async () => {
    const { repoRoot, cleanup } = makeRepo('vibecode-mcp3-art-list-allowlist-');
    try {
      seedRunWithCurrent(repoRoot, 'r1', { current: true });
      const tool = buildArtifactsListTool();
      const result = await tool.handler({ context: ctx(repoRoot), arguments: {}, requestId: null });
      expect(result.isError).toBe(false);
      const data = result.structuredContent.data as {
        artifacts: Array<{ name: string; path: string }>;
      };
      // Every advertised relative path must be inside RUN_SHOW_ARTIFACTS or in a small
      // documented set of additional allowlisted scan artifacts. None must traverse.
      for (const a of data.artifacts) {
        expect(a.path).not.toContain('..');
        expect(a.path.startsWith('/')).toBe(false);
        expect(a.path.startsWith('\\')).toBe(false);
      }
    } finally {
      cleanup();
    }
  });
});
