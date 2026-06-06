import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Settings v1 / Agent Guidance docs contract', () => {
  test('README documents the dedicated Agent Guidance config path under LOCALAPPDATA', () => {
    const text = read('README.md');
    expect(text).toMatch(/%LOCALAPPDATA%\/vibecodelight\/agent-guidance-config\.yaml/);
  });

  test('README states Settings is tabbed and lists the six tab names', () => {
    const text = read('README.md');
    expect(text).toMatch(/Flash · CodeGraph · MCP · Agent Guidance · Terminal · Advanced/);
  });

  test('README states this slice does not inject hidden text into the PTY', () => {
    const text = read('README.md');
    expect(text).toMatch(/not[\s\S]{0,40}inject hidden text into the PTY/i);
  });

  test('README states this slice does not modify final_prompt.md after preview', () => {
    const text = read('README.md');
    expect(text).toMatch(/does NOT modify[\s\S]{0,40}final_prompt\.md[\s\S]{0,40}after preview/i);
  });

  test('README states this slice does not mutate Claude/Codex approvals or permissions', () => {
    const text = read('README.md');
    expect(text).toMatch(/does NOT mutate Claude\/Codex/i);
  });

  test('README documents MCP-exposed Agent Guidance and agent-guidance CLI commands', () => {
    const text = read('README.md');
    expect(text).toMatch(/vibecode_mcp_guidance/);
    expect(text).toMatch(/vibecode agent-guidance status --agent claude/);
    expect(text).toMatch(/vibecode agent-guidance apply --agent codex/);
    expect(text).toMatch(/Restart\/reconnect/i);
    expect(text).toMatch(/MCP exposes Agent Guidance/i);
  });

  test('README documents Terminal Agent Preflight boundaries', () => {
    const text = read('README.md');
    expect(text).toMatch(/Terminal Agent Preflight/);
    expect(text).toMatch(/opening new Vibecode terminals/i);
    expect(text).toMatch(/user.*starts.*codex\/claude.*manually/i);
    expect(text).toMatch(/no Start Codex button/i);
    expect(text).toMatch(/no hidden PTY\/stdin injection/i);
    expect(text).toMatch(/no Composer.*final_prompt\.md mutation/i);
    expect(text).toMatch(/no approval\/permission mutation/i);
    expect(text).toMatch(/restart\/reconnect/i);
  });

  test('AGENTS.md adds the dedicated Agent Guidance config layer', () => {
    const text = read('AGENTS.md');
    expect(text).toMatch(/agent-guidance-config\.yaml/);
    expect(text).toMatch(/separate file, never merged into the root global config\.yaml/);
  });

  test('AGENTS.md lists agent-guidance preflight CLI and terminal boundaries', () => {
    const text = read('AGENTS.md');
    expect(text).toMatch(/vibecode agent-guidance preflight --repo <path> --terminal --json/);
    expect(text).toMatch(/Terminal Agent Preflight/);
    expect(text).toMatch(/does not start agents/i);
    expect(text).toMatch(/does not send text into the terminal/i);
  });

  test('docs/codegraph.md mentions the new boundaries explicitly under "intentionally not implemented"', () => {
    const text = read('docs/codegraph.md');
    expect(text).toMatch(/hidden PTY prompt injection/);
    expect(text).toMatch(/modification of `output\/final_prompt\.md` after the composer preview/);
    expect(text).toMatch(/mutation of Claude\/Codex approvals/);
    expect(text).toMatch(/agent-guidance-config\.yaml/);
    expect(text).toMatch(/vibecode_mcp_guidance/);
    expect(text).toMatch(/new MCP sessions/i);
  });

  test('docs/codegraph.md and roadmap mention Terminal Agent Preflight and restart/reconnect behavior', () => {
    const combined = `${read('docs/codegraph.md')}\n${read('docs/codegraph_mcp_roadmap.md')}`;
    expect(combined).toMatch(/Terminal Agent Preflight/);
    expect(combined).toMatch(/supported agents have VibecodeMCP configured/i);
    expect(combined).toMatch(/user still starts/i);
    expect(combined).toMatch(/no Start Codex/i);
    expect(combined).toMatch(/no hidden PTY\/stdin injection/i);
    expect(combined).toMatch(/no final_prompt\.md mutation/i);
    expect(combined).toMatch(/no approval\/permission mutation/i);
    expect(combined).toMatch(/restart\/reconnect/i);
  });
});
