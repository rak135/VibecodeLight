import fs from 'fs';
import os from 'os';
import path from 'path';

import { renderFinalPrompt } from '../../../src/core/prompting/renderer.js';
import type { CoordinationPromptContext } from '../../../src/core/coordination/prompt_context.js';

/** Minimal finalized run dir: only the artifacts renderFinalPrompt requires. */
function makeRunDir(tmpDir: string): string {
  const runId = 'test-run-coord';
  const runDir = path.join(tmpDir, runId);
  fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'Implement feature X.\n', 'utf8');
  fs.writeFileSync(
    path.join(runDir, 'run_manifest.json'),
    JSON.stringify({ run_id: runId, created_at: '2026-01-01T00:00:00.000Z', task: 'Implement feature X.', status: 'done' }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(runDir, 'output', 'context_pack.md'), '## Product Shape\n\nContext.\n', 'utf8');
  return runDir;
}

function readPrompt(runDir: string): string {
  return fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
}

const mcpContext: CoordinationPromptContext = {
  agent_id: 'agent-1',
  agent_name: 'Alice',
  agent_mode: 'mcp',
  terminal_session_id: 'term-1',
  held_claims: [{ claim_id: 'claim-1', path: 'src/a.ts', mode: 'exclusive' }],
  other_claims: [{ claim_id: 'claim-2', path: 'src/b.ts', mode: 'shared', agent_id: 'agent-2', agent_name: 'Bob' }],
};

describe('renderFinalPrompt — multi-agent coordination section', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-render-coord-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('renders an MCP coordination block with MCP tool names and protocol guidance', () => {
    const runDir = makeRunDir(tmpDir);
    const result = renderFinalPrompt(runDir, { coordination: mcpContext });
    expect(result.ok).toBe(true);
    const content = readPrompt(runDir);
    expect(content).toMatch(/^# Multi-Agent Coordination$/m);
    expect(content).toContain('MCP-capable');
    // v1 session / snapshot / claim / scope / release tool guidance.
    expect(content).toContain('vibecode_session_start');
    expect(content).toContain('vibecode_workspace_snapshot');
    expect(content).toContain('vibecode_build_start');
    expect(content).toContain('vibecode_build_scope');
    expect(content).toContain('vibecode_changes');
    expect(content).toContain('vibecode_handoff');
    // Old public MCP names must never be recommended to agents.
    expect(content).not.toMatch(/vibecode_(coordination_status|agents_list|agent_register|agent_heartbeat|claim_add|claims_list|claim_status|claim_release|finalize_check|evidence_list|evidence_scan)/);
    // Denied/blocked claim handling and final-report guidance.
    expect(content).toContain('denied/blocked paths');
    expect(content).toContain(
      'Report which claims you created, retained, released, or could not obtain.',
    );
    // MCP agents are told to run the v1 finish gate before the final report.
    expect(content).toContain('vibecode_build_finish');
    // Phase 4C: watcher evidence is mentioned (CLI-only commands) and described
    // as advisory, never as an enforcement gate.
    expect(content).toContain('vibecode evidence list --repo <path> --json');
    expect(content).toContain('vibecode evidence scan --repo <path> --json');
    expect(content.toLowerCase()).toContain('advisory');
    expect(content).not.toMatch(/watcher (blocks|enforces|prevents)/i);
    // Phase 4B: the scoped commit guard is CLI-only, so even MCP agents are pointed at it;
    // finalize check is mentioned before the commit guard, and broad staging is forbidden.
    expect(content).toContain('vibecode commit guard --repo <path> --agent agent-1');
    expect(content).toContain('git add -A');
    expect(content.indexOf('finalize check')).toBeLessThan(content.indexOf('vibecode commit guard'));
    // MCP agents are not told to shell out to the CLI claims/finalize commands.
    expect(content).not.toContain('vibecode claims add');
    expect(content).not.toContain('vibecode finalize check');
    // Handoffs exist but never transfer ownership automatically.
    expect(content).toContain('ownership never transfers automatically');
  });

  test('mentions the live watcher as advisory/non-enforcing in both modes', () => {
    for (const mode of ['mcp', 'cli', 'unknown'] as const) {
      const runDir = makeRunDir(tmpDir);
      renderFinalPrompt(runDir, { coordination: { ...mcpContext, agent_mode: mode } });
      const content = readPrompt(runDir);
      // Phase 4D: the block notes a live watcher may record evidence while running,
      // describes it as advisory/non-enforcing, and keeps finalize check + commit
      // guard as the enforcement path. It must never claim the watcher blocks edits.
      expect(content.toLowerCase()).toContain('live watcher');
      expect(content.toLowerCase()).toContain('advisory');
      expect(content).toContain('enforcement path');
      expect(content).not.toMatch(/watcher (blocks|enforces|prevents)/i);
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('renders a CLI coordination block with canonical CLI claim commands', () => {
    const runDir = makeRunDir(tmpDir);
    const cli: CoordinationPromptContext = { ...mcpContext, agent_mode: 'cli' };
    renderFinalPrompt(runDir, { coordination: cli });
    const content = readPrompt(runDir);
    expect(content).toContain('CLI-only');
    expect(content).toContain('vibecode agents list');
    expect(content).toContain('vibecode agents register');
    expect(content).toContain('vibecode agents heartbeat');
    expect(content).toContain('vibecode claims add --repo <path> --agent agent-1 --path');
    expect(content).toContain('vibecode claims list --repo <path> --json');
    expect(content).toContain('vibecode claims status --repo <path> --path');
    expect(content).toContain('vibecode claims release --repo <path> --claim');
    // Canonical --mode, never the --type alias.
    expect(content).toContain('--mode exclusive');
    expect(content).not.toContain('--type exclusive');
    expect(content).toContain('CLAIM_DENIED');
    expect(content).toContain('ownership never transfers automatically');
    // Phase 4A: CLI agents are told to run the finalize check CLI command.
    expect(content).toContain('vibecode finalize check --repo <path> --agent agent-1');
    // Phase 4C: watcher evidence CLI commands are mentioned as advisory.
    expect(content).toContain('vibecode evidence list --repo <path>');
    expect(content).toContain('vibecode evidence scan --repo <path>');
    expect(content).not.toMatch(/watcher (blocks|enforces|prevents)/i);
    // Phase 4B: the scoped commit guard CLI command and the git add -A prohibition.
    expect(content).toContain('vibecode commit guard --repo <path> --agent agent-1');
    expect(content).toContain('git add -A');
    expect(content).not.toContain('vibecode_claim_add');
    expect(content).not.toContain('vibecode_finalize_check');
  });

  test('unknown mode falls back to conservative CLI instructions', () => {
    const runDir = makeRunDir(tmpDir);
    const unknown: CoordinationPromptContext = { ...mcpContext, agent_mode: 'unknown' };
    renderFinalPrompt(runDir, { coordination: unknown });
    const content = readPrompt(runDir);
    expect(content).toMatch(/^# Multi-Agent Coordination$/m);
    expect(content).toContain('vibecode claims add --repo <path> --agent agent-1 --path');
    expect(content).toContain('--mode exclusive');
    expect(content).not.toContain('vibecode_claim_add');
  });

  test('lists claims held by this agent and files claimed by other active agents', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir, { coordination: mcpContext });
    const content = readPrompt(runDir);
    expect(content).toContain('src/a.ts (exclusive)');
    expect(content).toContain('src/b.ts');
    expect(content).toContain('Bob');
  });

  test('omits the coordination section when coordination is null', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir, { coordination: null });
    const content = readPrompt(runDir);
    expect(content).not.toContain('# Multi-Agent Coordination');
  });

  test('omits the coordination section when no coordination option is given', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir);
    const content = readPrompt(runDir);
    expect(content).not.toContain('# Multi-Agent Coordination');
  });

  test('positions the coordination block before Validation Expectations and after Task', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir, { coordination: mcpContext });
    const content = readPrompt(runDir);
    const coordIdx = content.indexOf('# Multi-Agent Coordination');
    const taskIdx = content.indexOf('# Task');
    const validationIdx = content.indexOf('# Validation Expectations');
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    expect(coordIdx).toBeGreaterThan(taskIdx);
    expect(validationIdx).toBeGreaterThan(coordIdx);
  });

  test('is deterministic and does not accumulate content across renders', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir, { coordination: mcpContext });
    const first = readPrompt(runDir);
    renderFinalPrompt(runDir, { coordination: mcpContext });
    const second = readPrompt(runDir);
    expect(second).toBe(first);
  });

  test('saved final_prompt.md is the source of truth (preview equals file, no hidden append)', () => {
    const runDir = makeRunDir(tmpDir);
    const result = renderFinalPrompt(runDir, { coordination: mcpContext, vibecodePath: path.join(tmpDir, '.vibecode') });
    expect(result.ok).toBe(true);
    const runFile = readPrompt(runDir);
    const currentFile = fs.readFileSync(path.join(tmpDir, '.vibecode', 'current', 'final_prompt.md'), 'utf8');
    // The mirror written for preview equals the canonical run artifact exactly.
    expect(currentFile).toBe(runFile);
    // The coordination block is part of that single saved artifact, not appended later.
    expect(runFile).toContain('# Multi-Agent Coordination');
  });
});
