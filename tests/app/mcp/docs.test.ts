import fs from 'fs';
import path from 'path';

import { VIBECODE_MCP_TOOL_NAMES } from '../../../src/app/mcp/index.js';

const repoRoot = path.resolve(__dirname, '../../..');
const contractPath = path.join(repoRoot, 'docs', 'VibecodeMCP_Tool_Contract_v1.md');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('VibecodeMCP v1 docs contract', () => {
  test('the new v1 contract document is the source of truth', () => {
    const text = fs.readFileSync(contractPath, 'utf8');
    expect(text).toMatch(/VibecodeMCP Tool Contract v1/i);
    expect(text).toMatch(/default profile exposes exactly these 14 tools/i);
    expect(text).toMatch(/old MCP tool names must not remain/i);
    for (const name of VIBECODE_MCP_TOOL_NAMES) {
      expect(text).toContain(name);
    }
  });

  test('deleted legacy MCP docs are not required by the docs test suite', () => {
    for (const rel of [
      'docs/ARCHITECTURE.md',
      'docs/codegraph.md',
      'docs/codegraph_mcp_roadmap.md',
    ]) {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(false);
    }
  });

  test('README documents the v1 public MCP surface and restart boundary', () => {
    const text = read('README.md');
    expect(text).toMatch(/vibecode mcp serve --repo/);
    expect(text).toMatch(/VibecodeMCP v1/i);
    expect(text).toMatch(/14 public MCP tools/i);
    expect(text).toMatch(/read-only tools/i);
    expect(text).toMatch(/build_start|vibecode_build_start/);
    expect(text).toMatch(/does not commit/i);
    expect(text).toMatch(/restart or\s+reconnect/i);
    for (const name of VIBECODE_MCP_TOOL_NAMES) {
      expect(text).toContain(name);
    }
  });

  test('AGENTS.md tells MCP-capable agents to start with the v1 session and snapshot tools', () => {
    const text = read('AGENTS.md');
    expect(text).toMatch(/vibecode_session_start/);
    expect(text).toMatch(/vibecode_workspace_snapshot/);
    expect(text).toMatch(/exactly 14 tools/i);
  });
});
