import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { sendFinalPromptForRun } from '../../src/app/desktop/prompt_send_service.js';
import { getRunInfo } from '../../src/core/runs/run_display.js';
import { sha256 } from '../../src/core/terminal/hash.js';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../../src/core/terminal/send_prompt.js';

const projectRoot = path.resolve(__dirname, '../..');
const binPath = path.join(projectRoot, 'bin', 'vibecode.js');

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
      VIBECODE_FLASH_PROVIDER: undefined,
      VIBECODE_FLASH_API_KEY: undefined,
      VIBECODE_FLASH_MODEL: undefined,
      VIBECODE_FLASH_BASE_URL: undefined,
      VIBECODE_FLASH_TIMEOUT_MS: undefined,
      VIBECODE_FLASH_MAX_TOKENS: undefined,
      VIBECODE_FLASH_TEMPERATURE: undefined,
    },
  });
}

function runGit(args: string[], cwd: string) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function makeRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo with spaces');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# prompt/send/run e2e fixture\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

function repoArg(repoRoot: string): string {
  return process.platform === 'win32' ? repoRoot.replace(/\\/g, '/') : repoRoot;
}

function runPromptMockJson(repoRoot: string, task: string) {
  const result = runCli(['prompt', task, '--repo', repoArg(repoRoot), '--mock', '--json'], repoRoot);
  expect(result.status).toBe(0);
  const envelope = JSON.parse(result.stdout.trim()) as {
    ok: boolean;
    data: {
      run_id: string;
      runDir: string;
      finalPromptPath: string;
      flash_input_path?: string;
      repo_atlas_path?: string;
      task_slice_path?: string;
      relevance_selection_path?: string;
      flash_input_budget_path?: string;
    };
    artifacts: string[];
    warnings: string[];
  };
  expect(envelope.ok).toBe(true);
  return envelope;
}

describe('prompt/send/run end-to-end characterization', () => {
  test('CLI mock prompt flow in a repo path with spaces writes the expected run artifacts, updates current consistently, and excludes .vibecode from scanned source', () => {
    const repoRoot = makeRepo('vibecode-prompt-e2e-');
    try {
      fs.mkdirSync(path.join(repoRoot, '.vibecode', 'ignored-subtree'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, '.vibecode', 'ignored-subtree', 'should_not_scan.md'), 'ignore me\n', 'utf8');

      const envelope = runPromptMockJson(repoRoot, 'e2e stability task');
      const { run_id, runDir, finalPromptPath } = envelope.data;
      const currentDir = path.join(repoRoot, '.vibecode', 'current');

      expect(path.resolve(runDir)).toBe(path.resolve(path.join(repoRoot, '.vibecode', 'runs', run_id)));
      expect(path.resolve(finalPromptPath)).toBe(path.resolve(path.join(runDir, 'output', 'final_prompt.md')));

      const expectedRunArtifacts = [
        'user_prompt.md',
        'run_manifest.json',
        'scanner_config.json',
        'scan/scan_manifest.json',
        'scan/repo_tree.txt',
        'scan/file_inventory.json',
        'scan/git_status.json',
        'scan/git_diff_stat.txt',
        'scan/ignore_rules.json',
        'scan/config_snapshot.json',
        'scan/manifests.json',
        'scan/commands.json',
        'scan/tooling.json',
        'scan/environment.json',
        'scan/repo_instructions.json',
        'scan/docs.json',
        'scan/architecture_docs.json',
        'scan/symbols.json',
        'scan/imports.json',
        'scan/entrypoints.json',
        'scan/tests.json',
        'scan/schemas.json',
        'scan/keyword_hits.json',
        'scan/recent_history.json',
        'flash/flash_input_manifest.json',
        'flash/flash_input.md',
        'flash/flash_output.md',
        'flash/flash_output_meta.json',
        'flash/tool_calls.json',
        'output/context_pack.md',
        'output/final_prompt.md',
        'skills/selected_skills.json',
        'skills/selected_skill_contents.md',
      ];

      for (const relativePath of expectedRunArtifacts) {
        expect(fs.existsSync(path.join(runDir, relativePath))).toBe(true);
      }

      expect(fs.readFileSync(path.join(runDir, 'user_prompt.md'), 'utf8')).toContain('e2e stability task');
      expect(fs.readFileSync(finalPromptPath, 'utf8')).toContain('e2e stability task');

      const runManifest = readJson<{ run_id: string; task: string }>(path.join(runDir, 'run_manifest.json'));
      const currentManifest = readJson<{ run_id: string; task: string }>(path.join(currentDir, 'run_manifest.json'));
      expect(runManifest.run_id).toBe(run_id);
      expect(currentManifest.run_id).toBe(run_id);
      expect(currentManifest.task).toBe('e2e stability task');
      expect(fs.readFileSync(path.join(currentDir, 'final_prompt.md'), 'utf8')).toBe(fs.readFileSync(finalPromptPath, 'utf8'));
      expect(fs.readFileSync(path.join(currentDir, 'context_pack.md'), 'utf8')).toBe(
        fs.readFileSync(path.join(runDir, 'output', 'context_pack.md'), 'utf8'),
      );

      const scannerConfig = readJson<{ repo_root: string }>(path.join(runDir, 'scanner_config.json'));
      expect(path.resolve(scannerConfig.repo_root)).toBe(path.resolve(repoRoot));

      const fileInventory = readJson<Array<{ path: string }>>(path.join(runDir, 'scan', 'file_inventory.json'));
      expect(fileInventory.some((entry) => entry.path.startsWith('.vibecode/'))).toBe(false);
      expect(fileInventory.every((entry) => !entry.path.includes('\\'))).toBe(true);

      const repoTree = fs.readFileSync(path.join(runDir, 'scan', 'repo_tree.txt'), 'utf8');
      expect(repoTree).not.toContain('.vibecode');
    } finally {
      fs.rmSync(path.join(repoRoot, '..'), { recursive: true, force: true });
    }
  });

  test('repeated CLI mock prompt runs preserve prior runs and move current/ to the latest run', () => {
    const repoRoot = makeRepo('vibecode-prompt-repeat-');
    try {
      const first = runPromptMockJson(repoRoot, 'first e2e run');
      const second = runPromptMockJson(repoRoot, 'second e2e run');
      const currentDir = path.join(repoRoot, '.vibecode', 'current');

      expect(second.data.run_id).not.toBe(first.data.run_id);
      expect(fs.existsSync(first.data.finalPromptPath)).toBe(true);
      expect(fs.existsSync(second.data.finalPromptPath)).toBe(true);
      expect(fs.readFileSync(first.data.finalPromptPath, 'utf8')).toContain('first e2e run');
      expect(fs.readFileSync(second.data.finalPromptPath, 'utf8')).toContain('second e2e run');

      const currentManifest = readJson<{ run_id: string; task: string }>(path.join(currentDir, 'run_manifest.json'));
      expect(currentManifest.run_id).toBe(second.data.run_id);
      expect(currentManifest.task).toBe('second e2e run');
      expect(fs.readFileSync(path.join(currentDir, 'final_prompt.md'), 'utf8')).toBe(
        fs.readFileSync(second.data.finalPromptPath, 'utf8'),
      );
    } finally {
      fs.rmSync(path.join(repoRoot, '..'), { recursive: true, force: true });
    }
  });

  test('desktop send of a CLI-created run uses the exact saved final_prompt.md and run artifacts remain authoritative after current mirror deletion', async () => {
    const repoRoot = makeRepo('vibecode-send-e2e-');
    try {
      const prompt = runPromptMockJson(repoRoot, 'send invariant e2e task');
      const savedPrompt = fs.readFileSync(prompt.data.finalPromptPath, 'utf8');
      const writes: Array<{ sessionId: string; data: string }> = [];
      const active = { sessionId: 'desktop-e2e-active', cwd: repoRoot, pid: 1234, shell: 'pwsh' };
      const service = {
        writeInput(sessionId: string, data: string) {
          writes.push({ sessionId, data });
        },
        getActiveSessionInfo() {
          return active;
        },
        getSession(sessionId: string) {
          return sessionId === active.sessionId ? active : undefined;
        },
      };

      const send = await sendFinalPromptForRun({
        runId: prompt.data.run_id,
        repoRoot,
        terminalService: service,
      });

      expect(send.ok).toBe(true);
      if (!send.ok) return;

      expect(writes.map((entry) => entry.sessionId)).toEqual([active.sessionId, active.sessionId]);
      expect(writes.slice(0, -1).map((entry) => entry.data).join('')).toBe(
        BRACKETED_PASTE_START + savedPrompt + BRACKETED_PASTE_END,
      );
      expect(writes.at(-1)?.data).toBe('\r');
      expect(send.metadata.content_sha256).toBe(sha256(savedPrompt));
      expect(send.metadata.sent_payload_sha256).toBe(
        sha256(BRACKETED_PASTE_START + savedPrompt + BRACKETED_PASTE_END + '\r'),
      );

      const primaryMetadata = readJson<Record<string, unknown>>(send.sendMetadataPath);
      const currentMetadata = readJson<Record<string, unknown>>(send.currentSendMetadataPath);
      expect(primaryMetadata).toEqual(send.metadata as unknown as Record<string, unknown>);
      expect(currentMetadata).toEqual(primaryMetadata);

      fs.rmSync(path.join(repoRoot, '.vibecode', 'current', 'final_prompt.md'), { force: true });
      fs.rmSync(path.join(repoRoot, '.vibecode', 'current', 'context_pack.md'), { force: true });
      fs.rmSync(path.join(repoRoot, '.vibecode', 'current', 'send_metadata.json'), { force: true });

      expect(fs.readFileSync(prompt.data.finalPromptPath, 'utf8')).toBe(savedPrompt);
      expect(fs.existsSync(path.join(prompt.data.runDir, 'output', 'context_pack.md'))).toBe(true);
      expect(fs.existsSync(send.sendMetadataPath)).toBe(true);

      const info = getRunInfo(prompt.data.runDir);
      expect(info.has_final_prompt).toBe(true);
      expect(info.has_send_metadata).toBe(true);
      expect(info.artifacts.final_prompt).toBe(path.join(prompt.data.runDir, 'output', 'final_prompt.md'));
      expect(info.artifacts.send_metadata).toBe(path.join(prompt.data.runDir, 'terminal', 'send_metadata.json'));

      const show = runCli(['runs', 'show', 'latest', '--repo', repoArg(repoRoot), '--json'], repoRoot);
      expect(show.status).toBe(0);
      const shown = JSON.parse(show.stdout.trim()) as {
        ok: boolean;
        data: {
          run_id: string;
          artifacts: { final_prompt?: string; send_metadata?: string };
        };
      };
      expect(shown.ok).toBe(true);
      expect(shown.data.run_id).toBe(prompt.data.run_id);
      expect(shown.data.artifacts.final_prompt).toBe(path.join(prompt.data.runDir, 'output', 'final_prompt.md'));
      expect(shown.data.artifacts.send_metadata).toBe(path.join(prompt.data.runDir, 'terminal', 'send_metadata.json'));
    } finally {
      fs.rmSync(path.join(repoRoot, '..'), { recursive: true, force: true });
    }
  });

  test('closed origin session for a CLI-created run fails cleanly and never retargets the active terminal', async () => {
    const repoRoot = makeRepo('vibecode-origin-e2e-');
    try {
      const prompt = runPromptMockJson(repoRoot, 'origin lifecycle e2e task');
      const active = { sessionId: 'live-active', cwd: repoRoot, pid: 77, shell: 'pwsh' };
      const writes: Array<{ sessionId: string; data: string }> = [];
      const service = {
        writeInput(sessionId: string, data: string) {
          writes.push({ sessionId, data });
        },
        getActiveSessionInfo() {
          return active;
        },
        getSession(sessionId: string) {
          return sessionId === active.sessionId ? active : undefined;
        },
      };

      const send = await sendFinalPromptForRun({
        runId: prompt.data.run_id,
        repoRoot,
        terminalService: service,
        targetSessionId: 'closed-origin-session',
      });

      expect(send.ok).toBe(false);
      if (send.ok) return;
      expect(send.error.code).toBe('ORIGIN_TERMINAL_CLOSED');
      expect(writes).toEqual([]);
      expect(fs.existsSync(path.join(prompt.data.runDir, 'terminal', 'send_metadata.json'))).toBe(false);
      expect(fs.existsSync(path.join(repoRoot, '.vibecode', 'current', 'send_metadata.json'))).toBe(false);
    } finally {
      fs.rmSync(path.join(repoRoot, '..'), { recursive: true, force: true });
    }
  });

  test('prompt-generated .vibecode artifacts stay out of git status when the repo ignores .vibecode/', () => {
    const repoRoot = makeRepo('vibecode-git-hygiene-');
    try {
      fs.writeFileSync(path.join(repoRoot, '.gitignore'), '.vibecode/\n', 'utf8');
      const init = runGit(['init'], repoRoot);
      expect(init.status).toBe(0);

      const prompt = runPromptMockJson(repoRoot, 'git hygiene task');
      expect(fs.existsSync(path.join(prompt.data.runDir, 'output', 'final_prompt.md'))).toBe(true);

      const status = runGit(['status', '--short'], repoRoot);
      expect(status.status).toBe(0);
      expect(status.stdout).not.toContain('.vibecode');

      const ignored = runGit(['status', '--short', '--ignored=matching'], repoRoot);
      expect(ignored.status).toBe(0);
      expect(ignored.stdout).toContain('.vibecode');

      const cached = runGit(['diff', '--cached', '--name-only'], repoRoot);
      expect(cached.status).toBe(0);
      expect(cached.stdout).not.toContain('.vibecode');
    } finally {
      fs.rmSync(path.join(repoRoot, '..'), { recursive: true, force: true });
    }
  });
});
