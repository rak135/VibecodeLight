import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../..');
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

describe('context finalize flow', () => {
  test('context-build, flash run --mock, and context finalize latest produce context artifacts only', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-context-finalize-flow-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'context finalize integration fixture\n', 'utf8');

    const contextBuild = runCli(['context-build', 'integration context finalize flow', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(contextBuild.status).toBe(0);
    const built = JSON.parse(contextBuild.stdout.trim());

    const flashRun = runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
    expect(flashRun.status).toBe(0);

    const finalize = runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);
    expect(finalize.status).toBe(0);

    const runDir = built.data.runDir;
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_output.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_output_meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'tool_calls.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'output', 'context_pack.md'))).toBe(true);
    // Flash-derived skill artifacts are intentionally absent in the manual-only flow.
    expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skills.json'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skill_contents.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'output', 'final_prompt.md'))).toBe(false);

    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });
});
