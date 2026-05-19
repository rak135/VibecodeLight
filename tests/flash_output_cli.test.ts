import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..');
const binPath = path.join(repoRoot, 'bin', 'vibecode.js');
const validFixture = path.join(__dirname, 'fixtures', 'flash_output_valid.md');
const invalidFixture = path.join(__dirname, 'fixtures', 'flash_output_missing_section.md');

function runCli(args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
}

describe('flash validate CLI', () => {
  test('flash validate <valid.md> exits 0', () => {
    const result = runCli(['flash', 'validate', validFixture]);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('flash output valid');
  });

  test('flash validate <invalid.md> exits 1', () => {
    const result = runCli(['flash', 'validate', invalidFixture]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('flash output invalid');
    expect(`${result.stdout}${result.stderr}`).toContain('Selected Skills');
  });

  test('flash validate <valid.md> --json returns canonical success envelope', () => {
    const result = runCli(['flash', 'validate', validFixture, '--json']);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());

    expect(payload).toEqual({
      ok: true,
      data: { sections: [
        'Task Summary',
        'Relevant Files',
        'Files To Read With Tools',
        'Relevant Tests',
        'Commands To Run',
        'Selected Skills',
        'Cautions',
        'Context Pack',
      ] },
      artifacts: [],
      warnings: [],
    });
  });

  test('flash validate <invalid.md> --json returns canonical error envelope', () => {
    const result = runCli(['flash', 'validate', invalidFixture, '--json']);
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim());

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('FLASH_OUTPUT_INVALID');
    expect(payload.error.details.join(' ')).toContain('Selected Skills');
  });

  test('smoke command fixture path exists', () => {
    expect(fs.existsSync(validFixture)).toBe(true);
    expect(fs.existsSync(invalidFixture)).toBe(true);
  });
});
