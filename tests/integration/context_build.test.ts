import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../..');

function runCli(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'vibecode.js'), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function runPnpmVibecode(args: string[], cwd = repoRoot) {
  const command = `pnpm vibecode ${args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ')}`;
  return spawnSync(command, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    shell: true,
  });
}

describe('context-build command', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-context-build-'));
    fs.writeFileSync(path.join(tmpRepo, 'hello.py'), 'print("hello")\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('vibecode context-build "task" --repo <tmpdir> exits 0', () => {
    const result = runCli(['context-build', 'integration task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);
  });

  test('vibecode context-build "task" --json returns canonical envelope with run_id and artifact paths', () => {
    const result = runCli(['context-build', 'integration json task', '--repo', tmpRepo, '--json']);
    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveProperty('run_id');
    expect(payload.data).toHaveProperty('flash_dir');
    expect(Array.isArray(payload.artifacts)).toBe(true);
    expect(Array.isArray(payload.warnings)).toBe(true);
    const artifactNames = payload.artifacts.map((entry: string) => path.basename(entry));
    expect(artifactNames).toContain('scan_manifest.json');
    expect(artifactNames).toContain('skills_catalog.json');
    expect(artifactNames).toContain('flash_input_manifest.json');
    expect(artifactNames).toContain('flash_input.md');
  });

  test('vibecode context-build creates scan, skills, and flash artifacts', () => {
    const result = runCli(['context-build', 'artifact creation task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);

    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runs = fs.readdirSync(runsDir);
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const runDir = path.join(runsDir, runs[0]);
    expect(fs.existsSync(path.join(runDir, 'scan', 'scan_manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'skills', 'skills_catalog.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input_manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input.md'))).toBe(true);

    const flashManifest = JSON.parse(
      fs.readFileSync(path.join(runDir, 'flash', 'flash_input_manifest.json'), 'utf8'),
    );
    expect(flashManifest.required_inputs.scanner_config).toBe('scanner_config.json');
    expect(flashManifest.artifacts.skills_catalog).toBe('skills/skills_catalog.json');
    expect(flashManifest.artifacts.scan_manifest).toBe('scan/scan_manifest.json');

    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_output.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'output', 'context_pack.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'output', 'final_prompt.md'))).toBe(false);
  });

  test('pnpm vibecode context-build creates flash input artifacts', () => {
    const result = runPnpmVibecode(['context-build', 'pnpm smoke task', '--repo', tmpRepo]);
    expect(result.status).toBe(0);

    const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
    const runs = fs.readdirSync(runsDir);
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const runDir = path.join(runsDir, runs[0]);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input_manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_input.md'))).toBe(true);
  });

  test('context-build includes previous completed run summary in flash input', () => {
    const first = runCli(['context-build', 'previous summary first task', '--repo', tmpRepo, '--json']);
    expect(first.status).toBe(0);
    const firstPayload = JSON.parse(first.stdout.trim());

    const second = runCli(['context-build', 'previous summary second task', '--repo', tmpRepo, '--json']);
    expect(second.status).toBe(0);
    const secondPayload = JSON.parse(second.stdout.trim());

    const flashInput = fs.readFileSync(
      path.join(secondPayload.data.runDir, 'flash', 'flash_input.md'),
      'utf8',
    );
    expect(flashInput).toContain('## Previous Run Summary');
    expect(flashInput).toContain(firstPayload.data.run_id);
    expect(flashInput).toContain('previous summary first task');
  });

  test('context-build prioritizes exact UI text from raw task before generic normalizer hints', () => {
    const exactText = 'Translates and expands your task into English search hints before context selection. Does not select files.';
    const rendererDir = path.join(tmpRepo, 'src', 'app', 'desktop', 'renderer');
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, 'index.html'), `<label>${exactText}</label>\n`, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'app', 'desktop', 'renderer', 'flash_settings.js'), 'export const taskNormalizerSettings = true;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'app', 'desktop', 'composer_bridge_task_normalizer.test.ts'), 'test("task normalizer settings", () => {});\n', 'utf8');
    const task = `odstraň z GUI popis task normalizeru - (${exactText})\nNechci tam žádný popis task normalizeru, jen ten přepínač co tam je teď`;

    const result = runCli(['context-build', task, '--repo', tmpRepo, '--task-normalizer', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim());
    const exactHits = JSON.parse(fs.readFileSync(path.join(payload.data.runDir, 'scan', 'exact_text_hits.json'), 'utf8'));
    const taskSlice = fs.readFileSync(path.join(payload.data.runDir, 'flash', 'task_slice.md'), 'utf8');
    const selection = JSON.parse(fs.readFileSync(path.join(payload.data.runDir, 'flash', 'relevance_selection.json'), 'utf8'));

    expect(exactHits.exact_text_hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provenance: 'exact_phrase',
        match_type: 'exact_text',
        path: 'src/app/desktop/renderer/index.html',
      }),
    ]));
    expect(selection.selected_files[0].path).toBe('src/app/desktop/renderer/index.html');
    expect(taskSlice).toContain(`src/app/desktop/renderer/index.html — selected by: exact text match: "${exactText}"`);
  });
});
