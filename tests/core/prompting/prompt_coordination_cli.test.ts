import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      VIBECODE_PROVIDER: undefined,
      VIBECODE_API_KEY: undefined,
      VIBECODE_MODEL: undefined,
      VIBECODE_BASE_URL: undefined,
    },
  });
}

function bindingPath(runDir: string): string {
  return path.join(runDir, 'coordination', 'agent_binding.json');
}

describe('prompt coordination binding (CLI)', () => {
  let tmpRepo: string;
  let runDir: string;
  let agentId: string;

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-coord-cli-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'coordination cli fixture\n', 'utf8');

    // Build a finalized run that has the prerequisites for `prompt render`.
    const build = runCli(['context-build', 'coordination render test', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(build.status).toBe(0);
    runDir = JSON.parse(build.stdout.trim()).data.runDir;
    runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
    runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);

    // Register an agent to bind to.
    const reg = runCli(['agents', 'register', '--name', 'Alice', '--type', 'claude', '--agent-mode', 'build', '--task', 'test task', '--json', '--repo', tmpRepo], tmpRepo);
    expect(reg.status).toBe(0);
    agentId = JSON.parse(reg.stdout.trim()).data.agent.agent_id;
  });

  afterAll(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('prompt render --agent --agent-mode mcp writes a binding and a coordination block', () => {
    const render = runCli(
      ['prompt', 'render', 'latest', '--agent', agentId, '--agent-mode', 'mcp', '--terminal-session', 'term-7', '--json', '--repo', tmpRepo],
      tmpRepo,
    );
    expect(render.status).toBe(0);

    expect(fs.existsSync(bindingPath(runDir))).toBe(true);
    const binding = JSON.parse(fs.readFileSync(bindingPath(runDir), 'utf8'));
    expect(binding).toMatchObject({
      agent_id: agentId,
      agent_mode: 'mcp',
      terminal_session_id: 'term-7',
      coordination_enabled: true,
    });

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toMatch(/^# Multi-Agent Coordination$/m);
    expect(content).toContain('vibecode_build_start');
    expect(content).not.toContain('vibecode_claim_add');

    // The convenience mirror written by the real CLI --agent path must be a
    // byte-for-byte copy of the canonical run artifact (no hidden mutation,
    // no separate rendering path for current/).
    const currentPrompt = fs.readFileSync(
      path.join(tmpRepo, '.vibecode', 'current', 'final_prompt.md'),
      'utf8',
    );
    expect(currentPrompt).toBe(content);
  });

  test('invalid agent_id returns a structured error and does not render', () => {
    const render = runCli(['prompt', 'render', 'latest', '--agent', 'ghost-agent', '--json', '--repo', tmpRepo], tmpRepo);
    expect(render.status).not.toBe(0);
    const envelope = JSON.parse(render.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('AGENT_NOT_FOUND');
  });

  test('invalid agent_mode returns a structured error', () => {
    const render = runCli(['prompt', 'render', 'latest', '--agent', agentId, '--agent-mode', 'bogus', '--json', '--repo', tmpRepo], tmpRepo);
    expect(render.status).not.toBe(0);
    const envelope = JSON.parse(render.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_AGENT_MODE');
  });

  test('prompt render without an agent does not add a coordination block', () => {
    // Fresh run with no binding.
    const build = runCli(['context-build', 'no coordination test', '--repo', tmpRepo, '--json'], tmpRepo);
    const freshRunDir = JSON.parse(build.stdout.trim()).data.runDir;
    runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
    runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);

    const render = runCli(['prompt', 'render', 'latest', '--repo', tmpRepo], tmpRepo);
    expect(render.status).toBe(0);
    expect(fs.existsSync(bindingPath(freshRunDir))).toBe(false);
    const content = fs.readFileSync(path.join(freshRunDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).not.toContain('# Multi-Agent Coordination');
  });

  test('full prompt pipeline with --agent writes a binding and coordination block', () => {
    const result = runCli(
      ['prompt', 'pipeline coordination test', '--mock', '--agent', agentId, '--agent-mode', 'cli', '--json', '--repo', tmpRepo],
      tmpRepo,
    );
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    const pipelineRunDir = envelope.data.runDir;
    expect(fs.existsSync(bindingPath(pipelineRunDir))).toBe(true);
    const content = fs.readFileSync(path.join(pipelineRunDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toMatch(/^# Multi-Agent Coordination$/m);
    expect(content).toContain('vibecode claims add --repo <path> --agent');
    expect(content).toContain('--mode exclusive');
  });
});
