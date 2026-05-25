import fs from 'fs';
import path from 'path';

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
    expect(previewSource).toMatch(/runPromptPipeline\(\{/);
    expect(previewSource).not.toMatch(/new\s+(OpenAiCompatibleAdapter|MockFlashAdapter)\b/);
    expect(previewSource).not.toMatch(/renderFinalPrompt\(/);
    expect(previewSource).not.toMatch(/buildFlashInput\(/);

    const sendSource = read(path.join(desktopRoot, 'prompt_send_service.ts'));
    expect(sendSource).toMatch(/from ['"][^'"]*core\/terminal\/send_prompt\.js['"]/);
    expect(sendSource).toMatch(/sendFinalPrompt\(\{/);
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
    expect(cliSource).toMatch(/renderFinalPrompt\(runDir, \{ vibecodePath: paths\.vibecode \}\)/);
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

    expect(vibecodeScannerRefs).toEqual([
      'src/core/runs/scan_phase.ts',
      'src/core/scanning/scanner_subprocess.ts',
    ]);

    for (const relPath of vibecodeScannerRefs) {
      const source = read(path.join(repoRoot, relPath));
      expect(source).toMatch(/spawnSync\(/);
      expect(source).toMatch(/['"]vibecode_scanner['"]/);
    }
  });

  test('LLM adapters stay within flash artifact ownership and do not write prompt/context/terminal artifacts', () => {
    const llmFiles = collectFiles(llmRoot, '.ts');
    expect(llmFiles.length).toBeGreaterThan(0);

    const directWriterFiles = llmFiles
      .filter((file) => /writeFileSync\(/.test(read(file)))
      .map(repoPath)
      .sort();
    expect(directWriterFiles).toEqual([
      'src/adapters/llm/mock_flash.ts',
      'src/adapters/llm/openai_compatible_adapter.ts',
    ]);

    const forbiddenArtifactMentions = /(context_pack\.md|final_prompt\.md|selected_skills\.json|selected_skill_contents\.md|send_metadata\.json)/;
    const violations: string[] = [];
    for (const file of llmFiles) {
      if (forbiddenArtifactMentions.test(read(file))) {
        violations.push(repoPath(file));
      }
    }
    assertNoViolations('LLM adapter source mentioned non-flash artifact ownership:', violations);
  });

  test('terminal send flow reads the saved final_prompt artifact and does not rebuild prompt content', () => {
    const sendSource = read(path.join(repoRoot, 'src', 'core', 'terminal', 'send_prompt.ts'));
    expect(sendSource).toMatch(/FINAL_PROMPT_RELATIVE_PATH/);
    expect(sendSource).toMatch(/const finalPromptPath = path\.join\(opts\.runDir, FINAL_PROMPT_RELATIVE_PATH\)/);
    expect(sendSource).toMatch(/fs\.readFileSync\(finalPromptPath, 'utf8'\)/);
    expect(sendSource).not.toMatch(/renderFinalPrompt\(/);
    expect(sendSource).not.toMatch(/runPromptPipeline\(/);
    expect(sendSource).not.toMatch(/buildFlashInput\(/);
    expect(sendSource).not.toMatch(/OpenAiCompatibleAdapter|MockFlashAdapter/);
  });
});
