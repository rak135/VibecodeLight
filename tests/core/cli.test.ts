import { spawnSync } from 'child_process';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const tsxCli = path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, 'src/app/cli/index.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('CLI basics', () => {
  test('vibecode --help outputs help text', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('vibecode');
  });

  test('vibecode doctor exits 0 and reports status', () => {
    const result = runCli(['doctor']);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('status');
  });
});
