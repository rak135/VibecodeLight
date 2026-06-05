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

describe('prompt render integration', () => {
  test('fixture repo with no selected skills: full mock pipeline omits the Selected Skills section from final_prompt.md', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prompt-render-noskills-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'no skills fixture\n', 'utf8');

    try {
      const build = runCli(['context-build', 'no skills test', '--repo', tmpRepo, '--json'], tmpRepo);
      expect(build.status).toBe(0);
      const built = JSON.parse(build.stdout.trim());

      const flashRun = runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
      expect(flashRun.status).toBe(0);

      const finalize = runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);
      expect(finalize.status).toBe(0);

      const render = runCli(['prompt', 'render', 'latest', '--repo', tmpRepo], tmpRepo);
      expect(render.status).toBe(0);

      const runDir = built.data.runDir;
      const finalPrompt = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
      expect(finalPrompt).not.toMatch(/no selected skills/i);
      expect(finalPrompt).not.toMatch(/^# Selected Skills$/m);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  test('full mock flow does not create send_metadata.json', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prompt-render-nosend-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'no send metadata fixture\n', 'utf8');

    try {
      const build = runCli(['context-build', 'no send metadata test', '--repo', tmpRepo, '--json'], tmpRepo);
      expect(build.status).toBe(0);
      const built = JSON.parse(build.stdout.trim());

      runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
      runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);
      runCli(['prompt', 'render', 'latest', '--repo', tmpRepo], tmpRepo);

      const runDir = built.data.runDir;
      expect(fs.existsSync(path.join(runDir, 'terminal', 'send_metadata.json'))).toBe(false);

      // Also check .vibecode/current
      const vibecodePath = path.join(tmpRepo, '.vibecode');
      expect(fs.existsSync(path.join(vibecodePath, 'current', 'send_metadata.json'))).toBe(false);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  test('prompt render updates current mirror artifacts', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prompt-render-current-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'current mirror fixture\n', 'utf8');

    try {
      const build = runCli(['context-build', 'current mirror test', '--repo', tmpRepo, '--json'], tmpRepo);
      expect(build.status).toBe(0);

      runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
      runCli(['context', 'finalize', 'latest', '--repo', tmpRepo], tmpRepo);
      runCli(['prompt', 'render', 'latest', '--repo', tmpRepo], tmpRepo);

      const vibecodePath = path.join(tmpRepo, '.vibecode');
      expect(fs.existsSync(path.join(vibecodePath, 'current', 'run_manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(vibecodePath, 'current', 'context_pack.md'))).toBe(true);
      // Legacy flash-derived selected_skills.json is no longer mirrored.
      expect(fs.existsSync(path.join(vibecodePath, 'current', 'selected_skills.json'))).toBe(false);
      expect(fs.existsSync(path.join(vibecodePath, 'current', 'final_prompt.md'))).toBe(true);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  test('fixture repo with manual --skill: selected skills section points to load command, no skill body', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prompt-render-manual-skill-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'manual skill fixture\n', 'utf8');
    const skillDir = path.join(tmpRepo, 'SKILLS', 'my-test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\ntitle: My Test Skill\nsummary: Manual selection sanity check.\n---\n# My Test Skill\n\nFull body content that must NOT appear inline.\n',
      'utf8',
    );

    try {
      const build = runCli(
        ['context-build', 'manual skill test', '--repo', tmpRepo, '--skill', 'my-test-skill', '--json'],
        tmpRepo,
      );
      expect(build.status).toBe(0);
      const built = JSON.parse(build.stdout.trim());

      runCli(['flash', 'run', 'latest', '--mock', '--repo', tmpRepo], tmpRepo);
      runCli(
        ['context', 'finalize', 'latest', '--repo', tmpRepo, '--skill', 'my-test-skill'],
        tmpRepo,
      );
      runCli(['prompt', 'render', 'latest', '--repo', tmpRepo], tmpRepo);

      const runDir = built.data.runDir;
      expect(fs.existsSync(path.join(runDir, 'skills', 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(runDir, 'skills', 'selected_skill_contents.md'))).toBe(false);

      const finalPrompt = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
      expect(finalPrompt).toMatch(/^# Selected Skills$/m);
      expect(finalPrompt).toContain('- my-test-skill');
      expect(finalPrompt).toContain('vibecode skills show my-test-skill --run-id');
      expect(finalPrompt).not.toContain('Full body content that must NOT appear inline.');
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  test('manual unknown --skill fails with SKILL_NOT_FOUND and writes no manifest', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-prompt-render-unknown-skill-'));
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'unknown skill fixture\n', 'utf8');

    try {
      const build = runCli(
        ['context-build', 'unknown skill test', '--repo', tmpRepo, '--skill', 'definitely-not-a-real-skill', '--json'],
        tmpRepo,
      );
      expect(build.status).toBe(1);
      const payload = JSON.parse(build.stdout.trim());
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('SKILL_NOT_FOUND');

      // Find the run dir from any newly created run.
      const runsDir = path.join(tmpRepo, '.vibecode', 'runs');
      if (fs.existsSync(runsDir)) {
        for (const runId of fs.readdirSync(runsDir)) {
          expect(fs.existsSync(path.join(runsDir, runId, 'skills', 'manifest.json'))).toBe(false);
        }
      }
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
