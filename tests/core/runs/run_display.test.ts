import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';
import { getRunInfo, listRuns } from '../../../src/core/runs/run_display.js';
import { getWorkspacePaths } from '../../../src/core/workspace/paths.js';

const repoRoot = path.resolve(__dirname, '../../..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');

function makeRepo(prefix: string): string {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), `${prefix} fixture\n`, 'utf8');
  return tmpRepo;
}

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

describe('run display', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = makeRepo('vibecode-run-display-');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('runs list lists created runs', async () => {
    const result = await runPromptPipeline({ task: 'runs list created run', repoRoot: tmpRepo, mock: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = getWorkspacePaths(tmpRepo);
    const runs = listRuns(paths.vibecode, paths.runs);

    expect(runs.map((run) => run.run_id)).toContain(result.run_id);
    const info = runs.find((run) => run.run_id === result.run_id);
    expect(info?.task).toBe('runs list created run');
    expect(info?.has_final_prompt).toBe(true);
  });

  test('runs show latest shows final_prompt path after full prompt run', async () => {
    const pipeline = await runPromptPipeline({ task: 'runs show latest final prompt', repoRoot: tmpRepo, mock: true });
    expect(pipeline.ok).toBe(true);
    if (!pipeline.ok) return;

    const show = runCli(['runs', 'show', 'latest', '--repo', tmpRepo], tmpRepo);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain(`run: ${pipeline.run_id}`);
    expect(show.stdout).toContain('final_prompt:');
    expect(show.stdout).toContain(path.join(pipeline.runDir, 'output', 'final_prompt.md'));

    const info = getRunInfo(pipeline.runDir);
    expect(info.artifacts.final_prompt).toBe(path.join(pipeline.runDir, 'output', 'final_prompt.md'));
  });

  test('runs show latest --json returns canonical envelope', async () => {
    const pipeline = await runPromptPipeline({ task: 'runs show latest json', repoRoot: tmpRepo, mock: true });
    expect(pipeline.ok).toBe(true);
    if (!pipeline.ok) return;

    const show = runCli(['runs', 'show', 'latest', '--repo', tmpRepo, '--json'], tmpRepo);
    expect(show.status).toBe(0);
    const envelope = JSON.parse(show.stdout.trim());

    expect(envelope.ok).toBe(true);
    expect(envelope.data.run_id).toBe(pipeline.run_id);
    expect(envelope.data.has_final_prompt).toBe(true);
    expect(envelope.data.artifacts.final_prompt).toBe(path.join(pipeline.runDir, 'output', 'final_prompt.md'));
    expect(Array.isArray(envelope.artifacts)).toBe(true);
    expect(Array.isArray(envelope.warnings)).toBe(true);
  });
});
