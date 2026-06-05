import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  runClaudeMcpDoctor,
  type ClaudeProcessRunner,
} from '../../../src/core/mcp/claude_config.js';
import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-doctor-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

describe('Claude MCP doctor', () => {
  let repoRoot: string;
  let calls: Array<{ command: string; args: string[]; cwd: string }>;

  beforeEach(() => {
    repoRoot = makeRepo();
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('checks Claude CLI, VibecodeMCP tools, and configured server without mutating config', () => {
    const runner: ClaudeProcessRunner = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      if (args.join(' ') === '--version') return { status: 0, stdout: '2.1.0\n', stderr: '' };
      if (args.join(' ') === 'mcp list') return { status: 0, stdout: 'vibecode connected\n', stderr: '' };
      if (args.join(' ') === 'mcp get vibecode') return { status: 0, stdout: 'vibecode stdio\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };

    const result = runClaudeMcpDoctor({
      repoRoot,
      runner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['mcp', 'list'],
      ['mcp', 'get', 'vibecode'],
    ]);
    expect(calls.every((call) => call.cwd === path.resolve(repoRoot))).toBe(true);
    expect(result.checks.claude_cli.ok).toBe(true);
    expect(result.checks.tools.ok).toBe(true);
    expect(result.suggestions.some((suggestion) => /\/mcp/i.test(suggestion))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'settings.json'))).toBe(false);
  });

  test('reports missing Claude CLI cleanly', () => {
    const result = runClaudeMcpDoctor({
      repoRoot,
      runner: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CLAUDE_CLI_NOT_FOUND');
    expect(result.checks.claude_cli.ok).toBe(false);
  });

  test('reports pending approval or trust as a warning only', () => {
    const runner: ClaudeProcessRunner = (command, args) => {
      if (args.join(' ') === '--version') return { status: 0, stdout: '2.1.0\n', stderr: '' };
      if (args.join(' ') === 'mcp list') return { status: 0, stdout: 'vibecode Pending approval\n', stderr: '' };
      if (args.join(' ') === 'mcp get vibecode') return { status: 0, stdout: 'Pending approval\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runClaudeMcpDoctor({
      repoRoot,
      scope: 'project',
      runner,
      toolsProvider: () => ({ ok: true, tools: [...VIBECODE_MCP_TOOL_NAMES] }),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => /pending approval|trust/i.test(warning))).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
