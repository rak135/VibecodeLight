import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CODEX_MCP_ENABLED_TOOLS,
  applyCodexMcpInstall,
  runCodexMcpDoctor,
} from '../../../src/core/mcp/codex_config.js';

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codex-doctor-'));
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  return repo;
}

describe('Codex MCP doctor', () => {
  let repoRoot: string;
  let codexHome: string;

  beforeEach(() => {
    repoRoot = makeRepo();
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codex-home-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  test('passes when config contains the expected VibecodeMCP block and tools command returns expected tools', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    fs.mkdirSync(path.dirname(vibecodeBinPath), { recursive: true });
    fs.writeFileSync(vibecodeBinPath, 'console.log("stub");\n', 'utf8');
    applyCodexMcpInstall({ repoRoot, scope: 'user', codexHome, yes: true, vibecodeBinPath });

    const result = runCodexMcpDoctor({
      repoRoot,
      scope: 'user',
      codexHome,
      vibecodeBinPath,
      codexExecutableChecker: () => false,
      toolsProvider: () => ({ ok: true, tools: [...CODEX_MCP_ENABLED_TOOLS] }),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.configured.ok).toBe(true);
    expect(result.checks.tools.ok).toBe(true);
    expect(result.warnings.some((w) => /Codex executable/i.test(w))).toBe(true);
    expect(result.suggestions.some((s) => /\/mcp/i.test(s))).toBe(true);
  });

  test('warns when configured enabled_tools differ from the expected read-only list', () => {
    const vibecodeBinPath = path.join(repoRoot, 'bin', 'vibecode.js');
    fs.mkdirSync(path.dirname(vibecodeBinPath), { recursive: true });
    fs.writeFileSync(vibecodeBinPath, 'console.log("stub");\n', 'utf8');
    applyCodexMcpInstall({ repoRoot, scope: 'user', codexHome, yes: true, vibecodeBinPath });
    const configPath = path.join(codexHome, 'config.toml');
    const modified = fs.readFileSync(configPath, 'utf8').replace('  "vibecode_codegraph_impact"', '  "vibecode_terminal_write"');
    fs.writeFileSync(configPath, modified, 'utf8');

    const result = runCodexMcpDoctor({
      repoRoot,
      scope: 'user',
      codexHome,
      vibecodeBinPath,
      codexExecutableChecker: () => true,
      toolsProvider: () => ({ ok: true, tools: [...CODEX_MCP_ENABLED_TOOLS] }),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.enabled_tools.ok).toBe(false);
    expect(result.warnings.some((w) => /enabled_tools/i.test(w))).toBe(true);
  });

  test('fails when the Codex config does not contain mcp_servers.vibecode', () => {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');

    const result = runCodexMcpDoctor({
      repoRoot,
      scope: 'user',
      codexHome,
      vibecodeBinPath: path.join(repoRoot, 'bin', 'vibecode.js'),
      toolsProvider: () => ({ ok: true, tools: [...CODEX_MCP_ENABLED_TOOLS] }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.configured.ok).toBe(false);
    expect(result.error?.code).toBe('CODEX_CONFIG_NOT_FOUND');
  });
});
