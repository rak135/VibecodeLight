import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerAgent } from '../../../src/core/coordination/agents.js';
import { addFileClaim, releaseFileClaim } from '../../../src/core/coordination/claims.js';
import {
  AGENT_MODES,
  isAgentMode,
  readAgentBinding,
  resolveAgentBindingInput,
  writeAgentBinding,
  type AgentBinding,
} from '../../../src/core/coordination/agent_binding.js';
import { buildCoordinationPromptContext } from '../../../src/core/coordination/prompt_context.js';
import { CoordinationError } from '../../../src/core/coordination/errors.js';

// Deterministic clocks: T0 then T_NOW (10 minutes later, beyond the 5-minute TTL).
const T0 = '2026-06-07T10:00:00.000Z';
const T_NOW = '2026-06-07T10:10:00.000Z';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-binding-'));
  return repo;
}

function makeRunDir(repo: string): string {
  const runDir = path.join(repo, '.vibecode', 'runs', '20260607-100000-TEST');
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

describe('agent binding artifact', () => {
  let repo: string;
  let runDir: string;

  beforeEach(() => {
    repo = makeRepo();
    runDir = makeRunDir(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('isAgentMode and AGENT_MODES expose mcp/cli/unknown', () => {
    expect([...AGENT_MODES].sort()).toEqual(['cli', 'mcp', 'unknown']);
    expect(isAgentMode('mcp')).toBe(true);
    expect(isAgentMode('cli')).toBe(true);
    expect(isAgentMode('unknown')).toBe(true);
    expect(isAgentMode('bogus')).toBe(false);
    expect(isAgentMode(42)).toBe(false);
  });

  test('write then read round-trips the binding fields', () => {
    const binding: AgentBinding = {
      agent_id: 'agent-1',
      terminal_session_id: 'term-9',
      agent_mode: 'mcp',
      coordination_enabled: true,
    };
    const out = writeAgentBinding(runDir, binding);
    expect(out.endsWith(path.join('coordination', 'agent_binding.json'))).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
    const read = readAgentBinding(runDir);
    expect(read).toEqual(binding);
  });

  test('read returns null when no binding artifact exists', () => {
    expect(readAgentBinding(runDir)).toBeNull();
  });

  test('read returns null for malformed JSON (resilient)', () => {
    const dir = path.join(runDir, 'coordination');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent_binding.json'), '{ not json', 'utf8');
    expect(readAgentBinding(runDir)).toBeNull();
  });

  test('write rejects an invalid agent_mode', () => {
    expect(() =>
      writeAgentBinding(runDir, {
        agent_id: 'agent-1',
        terminal_session_id: null,
        // @ts-expect-error intentional invalid mode
        agent_mode: 'bogus',
        coordination_enabled: true,
      }),
    ).toThrow(CoordinationError);
  });

  test('writing the binding does not modify run_manifest.json', () => {
    const manifestPath = path.join(runDir, 'run_manifest.json');
    const manifest = '{"run_id":"x","created_at":"y","task":"t","status":"done"}\n';
    fs.writeFileSync(manifestPath, manifest, 'utf8');
    writeAgentBinding(runDir, {
      agent_id: 'agent-1',
      terminal_session_id: null,
      agent_mode: 'cli',
      coordination_enabled: true,
    });
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifest);
  });
});

describe('resolveAgentBindingInput', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('returns a null binding when no coordination flags are supplied', () => {
    const result = resolveAgentBindingInput(repo, {}, { now: T_NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.binding).toBeNull();
  });

  test('resolves a valid registered agent into an enabled binding', () => {
    registerAgent(repo, { agent_name: 'Alice', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_NOW, agentId: 'agent-1' });
    const result = resolveAgentBindingInput(
      repo,
      { agentId: 'agent-1', agentMode: 'mcp', terminalSessionId: 'term-1' },
      { now: T_NOW },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding).toEqual({
        agent_id: 'agent-1',
        terminal_session_id: 'term-1',
        agent_mode: 'mcp',
        coordination_enabled: true,
      });
    }
  });

  test('defaults agent_mode to unknown when not supplied', () => {
    registerAgent(repo, { agent_name: 'Alice', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_NOW, agentId: 'agent-1' });
    const result = resolveAgentBindingInput(repo, { agentId: 'agent-1' }, { now: T_NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.binding?.agent_mode).toBe('unknown');
  });

  test('returns a structured error for an unknown agent_id', () => {
    const result = resolveAgentBindingInput(repo, { agentId: 'ghost' }, { now: T_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AGENT_NOT_FOUND');
  });

  test('returns a structured error for an invalid agent_mode', () => {
    registerAgent(repo, { agent_name: 'Alice', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_NOW, agentId: 'agent-1' });
    const result = resolveAgentBindingInput(repo, { agentId: 'agent-1', agentMode: 'bogus' }, { now: T_NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_AGENT_MODE');
  });
});

describe('buildCoordinationPromptContext', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
    // Stale agent registered at T0 with a claim it held while active.
    registerAgent(repo, { agent_name: 'Stale', agent_type: 'custom', metadata: { operating_mode: 'build', task: 'test' } }, { now: T0, agentId: 'agent-stale' });
    addFileClaim(repo, { agent_id: 'agent-stale', path: 'docs/old.md', mode: 'exclusive' }, { now: T0, claimId: 'claim-stale' });
    // Active agents registered at T_NOW.
    registerAgent(repo, { agent_name: 'Alice', agent_type: 'claude', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_NOW, agentId: 'agent-1' });
    registerAgent(repo, { agent_name: 'Bob', agent_type: 'codex', metadata: { operating_mode: 'build', task: 'test' } }, { now: T_NOW, agentId: 'agent-2' });
    addFileClaim(repo, { agent_id: 'agent-1', path: 'src/a.ts', mode: 'exclusive' }, { now: T_NOW, claimId: 'claim-1' });
    addFileClaim(repo, { agent_id: 'agent-2', path: 'src/b.ts', mode: 'shared' }, { now: T_NOW, claimId: 'claim-2' });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const bindingFor = (agentId: string | null, mode: AgentBinding['agent_mode'] = 'mcp'): AgentBinding => ({
    agent_id: agentId,
    terminal_session_id: 'term-1',
    agent_mode: mode,
    coordination_enabled: true,
  });

  test('returns null when binding is null', () => {
    expect(buildCoordinationPromptContext(repo, null, { now: T_NOW })).toBeNull();
  });

  test('returns null when coordination is disabled', () => {
    const binding = { ...bindingFor('agent-1'), coordination_enabled: false };
    expect(buildCoordinationPromptContext(repo, binding, { now: T_NOW })).toBeNull();
  });

  test('lists claims held by the bound agent', () => {
    const ctx = buildCoordinationPromptContext(repo, bindingFor('agent-1'), { now: T_NOW });
    expect(ctx).not.toBeNull();
    expect(ctx?.agent_id).toBe('agent-1');
    expect(ctx?.agent_name).toBe('Alice');
    expect(ctx?.agent_mode).toBe('mcp');
    expect(ctx?.held_claims).toEqual([
      { claim_id: 'claim-1', path: 'src/a.ts', mode: 'exclusive' },
    ]);
  });

  test('lists active claims held by OTHER agents and excludes the bound agent', () => {
    const ctx = buildCoordinationPromptContext(repo, bindingFor('agent-1'), { now: T_NOW });
    const otherPaths = ctx?.other_claims.map((c) => c.path);
    expect(otherPaths).toContain('src/b.ts');
    expect(otherPaths).not.toContain('src/a.ts');
    const bob = ctx?.other_claims.find((c) => c.path === 'src/b.ts');
    expect(bob).toMatchObject({ agent_id: 'agent-2', agent_name: 'Bob', mode: 'shared' });
  });

  test('excludes claims owned by stale agents from other_claims', () => {
    const ctx = buildCoordinationPromptContext(repo, bindingFor('agent-1'), { now: T_NOW });
    const paths = ctx?.other_claims.map((c) => c.path);
    expect(paths).not.toContain('docs/old.md');
  });

  test('excludes released claims from other_claims', () => {
    releaseFileClaim(repo, 'claim-2', { now: T_NOW });
    const ctx = buildCoordinationPromptContext(repo, bindingFor('agent-1'), { now: T_NOW });
    const paths = ctx?.other_claims.map((c) => c.path);
    expect(paths).not.toContain('src/b.ts');
  });

  test('handles an unknown bound agent_id gracefully (no held claims, no crash)', () => {
    const ctx = buildCoordinationPromptContext(repo, bindingFor('ghost'), { now: T_NOW });
    expect(ctx).not.toBeNull();
    expect(ctx?.agent_id).toBe('ghost');
    expect(ctx?.agent_name).toBeNull();
    expect(ctx?.held_claims).toEqual([]);
    // other_claims still reflect active agents.
    expect(ctx?.other_claims.map((c) => c.path)).toContain('src/a.ts');
  });
});
