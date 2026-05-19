import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function runCli(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

describe('context-build regression coverage', () => {
  test('context-build does not create flash_output.md, context_pack.md, or final_prompt.md', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-context-build-regression-'));
    fs.writeFileSync(path.join(tmpRepo, 'hello.py'), 'print("hello")\n', 'utf8');

    const result = runCli(['context-build', 'regression task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);

    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runs = fs.readdirSync(runsDir);
    expect(runs.length).toBeGreaterThan(0);

    const runDir = path.join(runsDir, runs[0]);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_output.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'output', 'context_pack.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'output', 'final_prompt.md'))).toBe(false);

    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });
});
