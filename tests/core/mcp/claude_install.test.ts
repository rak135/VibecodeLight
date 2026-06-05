import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyClaudeMcpInstall,
  type ClaudeProcessRunner,
} from '../../../src/core/mcp/claude_config.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-claude-install-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

describe('Claude MCP install', () => {
  let repoRoot: string;
  let calls: Array<{ command: string; args: string[]; cwd: string }>;

  beforeEach(() => {
    repoRoot = makeRepo();
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('dry run builds planned command and does not call mutating Claude command', () => {
    const runner: ClaudeProcessRunner = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = applyClaudeMcpInstall({ repoRoot, dryRun: true, runner });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.dry_run).toBe(true);
    expect(result.planned_command).toBe('claude mcp add-json vibecode <server-json> --scope local');
    expect(result.server_config.command).toBe('node');
    expect(calls).toEqual([]);
  });

  test('without --yes and without --dry-run refuses before running Claude', () => {
    const runner: ClaudeProcessRunner = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = applyClaudeMcpInstall({ repoRoot, runner });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('CLAUDE_MCP_INSTALL_FAILED');
    expect(result.error.message).toMatch(/--dry-run|--yes/);
    expect(calls).toEqual([]);
  });

  test('real install calls claude with argv array, repo cwd, bounded output, and no permission writes', () => {
    const runner: ClaudeProcessRunner = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return {
        status: 0,
        stdout: `${'o'.repeat(9000)}done`,
        stderr: `${'e'.repeat(9000)}warn`,
      };
    };

    const result = applyClaudeMcpInstall({ repoRoot, yes: true, scope: 'local', runner });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('claude');
    expect(calls[0].args.slice(0, 3)).toEqual(['mcp', 'add-json', 'vibecode']);
    expect(JSON.parse(calls[0].args[3])).toEqual(result.server_config);
    expect(calls[0].args.slice(4)).toEqual(['--scope', 'local']);
    expect(calls[0].cwd).toBe(path.resolve(repoRoot));
    expect(result.stdout.length).toBeLessThan(5000);
    expect(result.stderr.length).toBeLessThan(5000);
    expect(result.restart_required).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.mcp.json'))).toBe(false);
  });

  test('Claude CLI spawn errors and non-zero exits become structured errors', () => {
    const missing = applyClaudeMcpInstall({
      repoRoot,
      yes: true,
      runner: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected failure');
    expect(missing.error.code).toBe('CLAUDE_CLI_NOT_FOUND');

    const failed = applyClaudeMcpInstall({
      repoRoot,
      yes: true,
      runner: () => ({ status: 2, stdout: 'no', stderr: 'bad config' }),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('expected failure');
    expect(failed.error.code).toBe('CLAUDE_MCP_INSTALL_FAILED');
    expect(failed.stderr).toContain('bad config');
  });
});
