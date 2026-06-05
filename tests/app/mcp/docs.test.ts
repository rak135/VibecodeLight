import fs from 'fs';
import path from 'path';

import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

const repoRoot = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('VibecodeMCP MCP-1 docs contract', () => {
  test('README documents `vibecode mcp serve --repo <path>` and the 7 tool names', () => {
    const text = read('README.md');
    expect(text).toMatch(/vibecode mcp serve --repo/);
    expect(text).toMatch(/Phase MCP-1/i);
    expect(text).toMatch(/stdio only/i);
    expect(text).toMatch(/read-only/i);
    for (const name of VIBECODE_MCP_TOOL_NAMES) {
      expect(text).toContain(name);
    }
  });

  test('README explicitly contrasts VibecodeMCP with upstream `codegraph serve --mcp`', () => {
    const text = read('README.md');
    expect(text).toMatch(/codegraph serve --mcp/);
    expect(text).toMatch(/distinct from upstream/i);
  });

  test('README states agents with MCP use VibecodeMCP, others use the CLI', () => {
    const text = read('README.md');
    expect(text).toMatch(/[Aa]gents with MCP support use VibecodeMCP/);
    expect(text).toMatch(/without MCP support use/i);
  });

  test('README documents Codex MCP config/install and restart behavior', () => {
    const text = read('README.md');
    expect(text).toMatch(/vibecode mcp config --agent codex/);
    expect(text).toMatch(/vibecode mcp install --agent codex/);
    expect(text).toMatch(/restart or reload Codex/i);
    expect(text).toMatch(/agents without MCP support use/i);
  });

  test('README documents Claude Code managed MCP install without approval mutation', () => {
    const text = read('README.md');
    expect(text).toMatch(/vibecode mcp config --agent claude/);
    expect(text).toMatch(/vibecode mcp install --agent claude/);
    expect(text).toMatch(/claude mcp add-json/i);
    expect(text).toMatch(/default scope is local/i);
    expect(text).toMatch(/project scope/i);
    expect(text).toMatch(/approval\/permission/i);
    expect(text).toMatch(/Vibecode does not manage Claude.*approvals/i);
    expect(text).toMatch(/no write\/shell\/git\/terminal tools/i);
  });

  test('README states MCP-1 has no terminal/shell/git/write/file-write tools', () => {
    const text = read('README.md');
    expect(text).toMatch(/terminal write/);
    expect(text).toMatch(/shell exec/);
    expect(text).toMatch(/file write/);
    expect(text).toMatch(/git commit/);
  });

  test('AGENTS.md lists `vibecode mcp serve --repo <path>` under the public CLI', () => {
    const text = read('AGENTS.md');
    expect(text).toMatch(/vibecode mcp serve --repo/);
    expect(text).toMatch(/vibecode mcp tools/);
    expect(text).toMatch(/vibecode mcp config --agent codex/);
    expect(text).toMatch(/vibecode mcp install --agent codex/);
    expect(text).toMatch(/vibecode mcp doctor --agent codex/);
    expect(text).toMatch(/vibecode mcp config --agent claude/);
    expect(text).toMatch(/vibecode mcp install --agent claude/);
    expect(text).toMatch(/vibecode mcp doctor --agent claude/);
  });

  test('docs/ARCHITECTURE.md lists src/app/mcp/ as a third app entrypoint', () => {
    const text = read('docs/ARCHITECTURE.md');
    expect(text).toMatch(/src\/app\/mcp\//);
    expect(text).toMatch(/third app entrypoint/i);
  });

  test('docs/codegraph.md notes the distinction between VibecodeMCP and upstream', () => {
    const text = read('docs/codegraph.md');
    expect(text).toMatch(/VibecodeMCP server \(Phase MCP-1\)/);
    expect(text).toMatch(/codegraph serve --mcp/);
    expect(text).toMatch(/stdio-only/);
    expect(text).toMatch(/read-only/);
    expect(text).toMatch(/vibecode mcp install --agent codex/);
    expect(text).toMatch(/vibecode mcp install --agent claude/);
    expect(text).toMatch(/Claude Code MCP config through `claude mcp add-json`/);
    expect(text).toMatch(/Vibecode does not manage Claude.*approval/i);
    expect(text).toMatch(/Codex must be restarted or reloaded/i);
  });

  test('docs/codegraph_mcp_roadmap.md reflects MCP-1 as implemented', () => {
    const text = read('docs/codegraph_mcp_roadmap.md');
    expect(text).toMatch(/MCP-1.*implemented/);
    expect(text).toMatch(/vibecode mcp serve --repo/);
    expect(text).toMatch(/Codex installer.*implemented/i);
    expect(text).toMatch(/Claude installer.*implemented/i);
  });
});
