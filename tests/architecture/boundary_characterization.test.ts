import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeCodeGraphContextArtifacts } from '../../src/adapters/codegraph/codegraph_context.js';
import { runPromptPipeline } from '../../src/core/prompting/pipeline.js';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const coreRoot = path.join(repoRoot, 'src', 'core');
const desktopRoot = path.join(repoRoot, 'src', 'app', 'desktop');
const scannerPythonRoot = path.join(repoRoot, 'src', 'core', 'scanning', 'python', 'vibecode_scanner');
const llmRoot = path.join(repoRoot, 'src', 'adapters', 'llm');

function collectFiles(dir: string, extension: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, extension));
    } else if (entry.isFile() && fullPath.endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectAllFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function repoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function collectViolations(files: string[], regex: RegExp): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const source = read(file);
    const matches = [...source.matchAll(regex)].map((match) => match[0].trim());
    for (const match of matches) {
      violations.push(`${repoPath(file)} :: ${match}`);
    }
  }
  return violations;
}

function assertNoViolations(label: string, violations: string[]): void {
  if (violations.length > 0) {
    throw new Error(`${label}\n${violations.join('\n')}`);
  }
}

const APP_LAYER_IMPORT = /(?:^\s*import(?:[\s\S]*?\sfrom\s*)?['"][^'"]*app\/(?:desktop|cli)[^'"]*['"]|require\(\s*['"][^'"]*app\/(?:desktop|cli)[^'"]*['"]\s*\))/gm;
const ELECTRON_OR_RENDERER_IMPORT = /(?:^\s*import(?:[\s\S]*?\sfrom\s*)?['"]electron['"]|require\(\s*['"]electron['"]\s*\)|^\s*import(?:[\s\S]*?\sfrom\s*)?['"][^'"]*renderer\/[^'"]*['"]|require\(\s*['"][^'"]*renderer\/[^'"]*['"]\s*\))/gm;
const LLM_ADAPTER_IMPORT = /(?:^\s*import(?:[\s\S]*?\sfrom\s*)?['"][^'"]*adapters\/llm[^'"]*['"]|require\(\s*['"][^'"]*adapters\/llm[^'"]*['"]\s*\))/gm;

function expectNoForbiddenScannerConcepts(files: string[]): void {
  const forbidden = [
    { label: 'provider or API-key concepts', regex: /\b(openai|anthropic|provider|api[_-]?key|authorization|bearer)\b/i },
    { label: 'network client imports', regex: /\b(requests|httpx|aiohttp|urllib)\b/ },
    { label: 'skills ownership', regex: /(selected_skills|selected_skill_contents|skills_catalog|skill_catalog|SKILL\.md|skills\/)/ },
  ];

  const violations: string[] = [];
  for (const file of files) {
    const source = read(file);
    for (const rule of forbidden) {
      if (rule.regex.test(source)) {
        violations.push(`${repoPath(file)} :: ${rule.label}`);
      }
    }
  }
  assertNoViolations('Python scanner crossed forbidden ownership boundary:', violations);
}

describe('architecture boundary characterization', () => {
  test('core does not import app-layer or Electron renderer modules', () => {
    const coreFiles = collectFiles(coreRoot, '.ts');
    expect(coreFiles.length).toBeGreaterThan(0);

    assertNoViolations(
      'Core imported app-layer modules:',
      collectViolations(coreFiles, APP_LAYER_IMPORT),
    );
    assertNoViolations(
      'Core imported Electron or renderer modules:',
      collectViolations(coreFiles, ELECTRON_OR_RENDERER_IMPORT),
    );
  });

  test('desktop shell delegates preview/send behavior through current core gateways instead of duplicating prompt ownership', () => {
    const previewSource = read(path.join(desktopRoot, 'prompt_preview_service.ts'));
    expect(previewSource).toMatch(/from ['"][^'"]*core\/prompting\/pipeline\.js['"]/);
    expect(previewSource).toMatch(/runPromptPipeline\(/);
    expect(previewSource).not.toMatch(/new\s+(OpenAiCompatibleAdapter|MockFlashAdapter)\b/);
    expect(previewSource).not.toMatch(/renderFinalPrompt\(/);
    expect(previewSource).not.toMatch(/buildFlashInput\(/);

    const sendSource = read(path.join(desktopRoot, 'prompt_send_service.ts'));
    expect(sendSource).toMatch(/from ['"][^'"]*core\/terminal\/send_prompt\.js['"]/);
    expect(sendSource).toMatch(/sendFinalPrompt\(/);
    expect(sendSource).not.toMatch(/runPromptPipeline\(/);
    expect(sendSource).not.toMatch(/renderFinalPrompt\(/);

    const desktopFiles = collectFiles(desktopRoot, '.ts');
    const directWriteFiles = desktopFiles
      .filter((file) => /writeFileSync\(/.test(read(file)))
      .map(repoPath)
      .sort();
    expect(directWriteFiles).toEqual([]);
  });

  test('CLI render flow delegates final prompt ownership to the core renderer', () => {
    const cliSource = read(path.join(repoRoot, 'src', 'app', 'cli', 'index.ts'));
    expect(cliSource).toMatch(/from ['"][^'"]*core\/prompting\/index\.js['"]/);
    expect(cliSource).toMatch(/renderFinalPrompt\(/);
    expect(cliSource).not.toMatch(/writeFileSync\([^\n]*final_prompt\.md/);
  });

  test('Python scanner package does not reference provider, skills, or workspace-root ownership concepts', () => {
    const pythonFiles = collectFiles(scannerPythonRoot, '.py');
    expect(pythonFiles.length).toBeGreaterThan(0);
    expectNoForbiddenScannerConcepts(pythonFiles);
  });

  test('TypeScript scanner orchestration remains a subprocess boundary and does not import LLM adapters', () => {
    const scanningTsFiles = collectFiles(path.join(repoRoot, 'src', 'core', 'scanning'), '.ts');
    expect(scanningTsFiles.length).toBeGreaterThan(0);
    assertNoViolations(
      'Scanner orchestration imported LLM adapter modules:',
      collectViolations(scanningTsFiles, LLM_ADAPTER_IMPORT),
    );

    const allTsFiles = collectFiles(path.join(repoRoot, 'src'), '.ts');
    const vibecodeScannerRefs = allTsFiles
      .filter((file) => read(file).includes('vibecode_scanner'))
      .map(repoPath)
      .sort();

    // The invariant is the subprocess boundary, not the exact file list: every TS file
    // that names the scanner must invoke it via spawnSync rather than import it in-process.
    expect(vibecodeScannerRefs.length).toBeGreaterThan(0);
    for (const relPath of vibecodeScannerRefs) {
      const source = read(path.join(repoRoot, relPath));
      expect(source).toMatch(/spawnSync\(/);
      expect(source).toMatch(/['"]vibecode_scanner['"]/);
    }
  });

  test('LLM adapters stay within flash artifact ownership and do not write prompt/context/terminal artifacts', () => {
    const llmFiles = collectFiles(llmRoot, '.ts');
    expect(llmFiles.length).toBeGreaterThan(0);

    // Ownership is defined by what adapters are forbidden to touch (prompt/context/terminal
    // artifacts), not by freezing exactly which adapter files perform writes.
    const forbiddenArtifactMentions = /(context_pack\.md|final_prompt\.md|selected_skills\.json|selected_skill_contents\.md|send_metadata\.json)/;
    const violations: string[] = [];
    for (const file of llmFiles) {
      if (forbiddenArtifactMentions.test(read(file))) {
        violations.push(repoPath(file));
      }
    }
    assertNoViolations('LLM adapter source mentioned non-flash artifact ownership:', violations);
  });

  test('flash provider adapters do not reconstruct run artifact paths from .vibecode layout', () => {
    const adapterFiles = [
      path.join(llmRoot, 'mock_flash.ts'),
      path.join(llmRoot, 'openai_compatible_adapter.ts'),
    ];

    const violations = adapterFiles
      .filter((file) => /\.vibecode/.test(read(file)))
      .map(repoPath);

    assertNoViolations('Flash provider adapters hardcoded generated run layout:', violations);
  });

  test('terminal send flow reads the saved final_prompt artifact and does not rebuild prompt content', () => {
    const sendSource = read(path.join(repoRoot, 'src', 'core', 'terminal', 'send_prompt.ts'));
    // Reads the saved artifact (via the shared path constant) instead of rebuilding prompt content.
    expect(sendSource).toMatch(/FINAL_PROMPT_RELATIVE_PATH/);
    expect(sendSource).toMatch(/readFileSync\(/);
    expect(sendSource).not.toMatch(/renderFinalPrompt\(/);
    expect(sendSource).not.toMatch(/runPromptPipeline\(/);
    expect(sendSource).not.toMatch(/buildFlashInput\(/);
    expect(sendSource).not.toMatch(/OpenAiCompatibleAdapter|MockFlashAdapter/);
  });

  test('current final_prompt mirror is byte-identical to the run output final_prompt when both exist', async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-final-prompt-mirror-'));
    try {
      fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Mirror fixture\n', 'utf8');

      const result = await runPromptPipeline({ task: 'mirror byte equality characterization', repoRoot: tmpRepo, mock: true });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runFinalPromptPath = path.join(result.runDir, 'output', 'final_prompt.md');
      const currentFinalPromptPath = path.join(tmpRepo, '.vibecode', 'current', 'final_prompt.md');
      expect(fs.existsSync(runFinalPromptPath)).toBe(true);
      expect(fs.existsSync(currentFinalPromptPath)).toBe(true);
      expect(fs.readFileSync(currentFinalPromptPath)).toEqual(fs.readFileSync(runFinalPromptPath));
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  test('CodeGraph adapter writes only the current characterized run artifact surface', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-codegraph-write-surface-'));
    try {
      const runDir = path.join(tmpRepo, '.vibecode', 'runs', '20260602-000000-CG00');
      const scanDir = path.join(runDir, 'scan');
      fs.mkdirSync(scanDir, { recursive: true });
      fs.writeFileSync(
        path.join(scanDir, 'file_inventory.json'),
        `${JSON.stringify({ files: [{ path: 'src/app/cli/index.ts' }] }, null, 2)}\n`,
        'utf8',
      );
      const before = new Set(collectAllFiles(runDir).map((file) => path.relative(runDir, file).replace(/\\/g, '/')));

      writeCodeGraphContextArtifacts({
        runDir,
        result: {
          ok: true,
          used: true,
          mode: 'use-existing',
          command: ['codegraph', 'context', 'characterize'],
          outputText: '# CodeGraph Context\n### Entry Points\n- `src/app/cli/index.ts` — `runContextBuild`',
          warnings: [],
          reason: 'EXISTING_INDEX',
        },
      });

      const written = collectAllFiles(runDir)
        .map((file) => path.relative(runDir, file).replace(/\\/g, '/'))
        .filter((relativePath) => !before.has(relativePath))
        .sort();

      expect(written).toEqual([
        'scan/codegraph_context.md',
        'scan/codegraph_repo_atlas.json',
        'scan/codegraph_repo_atlas.md',
        'scan/codegraph_usage.json',
        // Legacy/back-compat duplicate artifacts for current production behavior.
        'scan/repo_atlas.json',
        'scan/repo_atlas.md',
      ].sort());

      // scan/codegraph_repo_atlas.* is the current canonical implementation path.
      // scan/repo_atlas.* remains a legacy duplicate. Do not move these paths in this PR;
      // scan/atlas/* may be a future cleanup target but is not current Stage 0 behavior.
      expect(fs.existsSync(path.join(runDir, 'scan', 'atlas', 'codegraph_repo_atlas.md'))).toBe(false);
      expect(fs.existsSync(path.join(runDir, 'scan', 'atlas', 'codegraph_repo_atlas.json'))).toBe(false);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
