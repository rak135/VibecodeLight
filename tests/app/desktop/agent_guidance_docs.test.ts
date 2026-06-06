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

  test('AGENTS.md adds the dedicated Agent Guidance config layer', () => {
    const text = read('AGENTS.md');
    expect(text).toMatch(/agent-guidance-config\.yaml/);
    expect(text).toMatch(/separate file, never merged into the root global config\.yaml/);
  });

  test('docs/codegraph.md mentions the new boundaries explicitly under "intentionally not implemented"', () => {
    const text = read('docs/codegraph.md');
    expect(text).toMatch(/hidden PTY prompt injection/);
    expect(text).toMatch(/modification of `output\/final_prompt\.md` after the composer preview/);
    expect(text).toMatch(/mutation of Claude\/Codex approvals/);
    expect(text).toMatch(/agent-guidance-config\.yaml/);
  });
});
