import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const scannerDir = path.resolve(__dirname, '../../src/core/scanning/python');

function runPython(args: string[], cwd = scannerDir) {
  return spawnSync('python', args, { cwd, encoding: 'utf8' });
}

describe('Python scanner', () => {
  test('Python scanner --help exits 0', () => {
    const result = runPython(['-m', 'vibecode_scanner', '--help']);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('scanner');
  });

  test('Python scanner writes scan_manifest.json when --out is provided', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-python-'));
    const outDir = path.join(root, 'scan');
    const result = runPython(['-m', 'vibecode_scanner', '--repo', root, '--task', 'test task', '--out', outDir]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(outDir, 'scan_manifest.json'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'scan_manifest.json'), 'utf8'));
    expect(manifest.status).toBe('skeleton');
  });
});
