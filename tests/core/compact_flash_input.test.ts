import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildFlashInput,
  buildFlashInputManifest,
  estimateTokens,
} from '../../src/core/context/index.js';

function makeRunFixture(): { repoRoot: string; runDir: string; flashDir: string; runId: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-compact-flash-'));
  const runId = 'run-compact-001';
  const runDir = path.join(repoRoot, '.vibecode', 'runs', runId);
  const flashDir = path.join(runDir, 'flash');
  fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
  fs.mkdirSync(flashDir, { recursive: true });

  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'Fix compact flash input for prompt pipeline\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify({ run_id: runId, created_at: '2026-01-01T00:00:00.000Z', task: 'Fix compact flash input for prompt pipeline', status: 'running' }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scanner_config.json'), JSON.stringify({ run_id: runId, repo_root: repoRoot, task: 'Fix compact flash input for prompt pipeline', paths: { scan_out: 'scan' } }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'skills', 'skills_catalog.json'), JSON.stringify({ generated_at: 'x', skills: [], warnings: [] }), 'utf8');

  const files = [
    'src/app/cli/index.ts',
    'src/app/desktop/renderer/index.html',
    'src/core/context/flash_input_builder.ts',
    'src/core/context/flash_input_manifest.ts',
    'src/core/prompting/pipeline.ts',
    'src/core/config/index.ts',
    'src/core/scanning/python/vibecode_scanner/scan/base_scan.py',
    'src/adapters/llm/openai_compatible_adapter.ts',
    'src/adapters/pty/node_pty.ts',
    'SKILLS/test-driven-development/SKILL.md',
    'docs/ARCHITECTURE_DECISIONS.md',
    'docs/IMPLEMENTATION_MAP.md',
    'tests/core/context.test.ts',
    'tests/integration/context_build.test.ts',
    'tests/app/desktop/renderer_terminal_copy.test.ts',
  ];
  fs.writeFileSync(path.join(runDir, 'scan', 'file_inventory.json'), JSON.stringify(files.map((filePath) => ({ path: filePath, size_bytes: 1234, language: filePath.endsWith('.py') ? 'python' : filePath.endsWith('.md') ? 'markdown' : 'typescript' })), null, 2), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'repo_tree.txt'), files.join('\n'), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'scan_manifest.json'), JSON.stringify({ ok: true, run_id: runId, artifacts: { 'file_inventory.json': path.join(runDir, 'scan', 'file_inventory.json') }, warnings: [] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'manifests.json'), JSON.stringify({ manifests: [{ path: 'package.json', package_manager: 'pnpm', scripts: { test: 'vitest run', lint: 'eslint .' } }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'commands.json'), JSON.stringify({ commands: [{ name: 'test', command: 'pnpm test' }, { name: 'lint', command: 'pnpm lint' }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'repo_instructions.json'), JSON.stringify({ repo_instructions: [{ path: 'AGENTS.md', headings: ['Document Authority', 'Skill Discipline'], excerpt: 'Use TDD. Keep prompt pipeline visible. Do not expose secrets.' }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'docs.json'), JSON.stringify({ docs: [{ path: 'README.md', headings: ['VibecodeLight'], excerpt: 'VibecodeLight builds reproducible prompts for real terminal agents.' }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'architecture_docs.json'), JSON.stringify({ architecture_docs: [{ path: 'docs/ARCHITECTURE_DECISIONS.md', headings: ['Core Decision', 'Markdown-first flash output'], excerpt: 'TypeScript owns workflow orchestration. Python owns deterministic scanning.' }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'symbols.json'), JSON.stringify({ symbols: Array.from({ length: 500 }, (_, index) => ({ path: index % 2 === 0 ? 'src/core/context/flash_input_builder.ts' : 'src/app/cli/index.ts', name: `symbol${index}`, signature: `function symbol${index}()`, line: index + 1 })) }, null, 2), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'imports.json'), JSON.stringify({ imports: Array.from({ length: 500 }, (_, index) => ({ path: index % 2 === 0 ? 'src/core/context/flash_input_builder.ts' : 'src/app/cli/index.ts', target: index % 2 === 0 ? './flash_input_manifest.js' : '../../core/context/index.js', kind: 'local', line: index + 1 })) }, null, 2), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'tests.json'), JSON.stringify({ tests: [{ path: 'tests/core/context.test.ts', name: 'buildFlashInput' }, { path: 'tests/integration/context_build.test.ts', name: 'context build' }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'keyword_hits.json'), JSON.stringify({ keyword_hits: [{ path: 'src/core/context/flash_input_builder.ts', match_type: 'path', excerpt: 'flash input builder' }, { path: 'tests/core/context.test.ts', match_type: 'path', excerpt: 'flash input tests' }] }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'scan', 'recent_history.json'), JSON.stringify({ commits: Array.from({ length: 20 }, (_, index) => ({ hash: `abc${index}`, subject: `commit ${index}` })) }), 'utf8');
  return { repoRoot, runDir, flashDir, runId };
}

function buildFixtureInput(fixture = makeRunFixture()): { fixture: ReturnType<typeof makeRunFixture>; content: string } {
  const manifest = buildFlashInputManifest({
    run_id: fixture.runId,
    task: 'Fix compact flash input for prompt pipeline',
    repo_root: fixture.repoRoot,
    runDir: fixture.runDir,
  });
  const content = buildFlashInput({
    run_id: fixture.runId,
    task: 'Fix compact flash input for prompt pipeline',
    repo_root: fixture.repoRoot,
    runDir: fixture.runDir,
    manifest,
  });
  return { fixture, content };
}

describe('compact Repo Atlas + Task Slice flash input', () => {
  test('creates repo_atlas.generated.md and a per-run repo_atlas.md with major subsystems', () => {
    const { fixture } = buildFixtureInput();
    const indexAtlasPath = path.join(fixture.repoRoot, '.vibecode', 'index', 'repo_atlas.generated.md');
    const runAtlasPath = path.join(fixture.flashDir, 'repo_atlas.md');

    expect(fs.existsSync(indexAtlasPath)).toBe(true);
    expect(fs.existsSync(runAtlasPath)).toBe(true);
    const atlas = fs.readFileSync(runAtlasPath, 'utf8');
    for (const subsystem of ['CLI', 'Desktop', 'Prompting Pipeline', 'Config', 'LLM Adapters', 'Scanner', 'Skills', 'Terminal/PTY', 'Tests', 'Docs']) {
      expect(atlas).toContain(subsystem);
    }
    expect(atlas).toContain('scan/symbols.json');
    expect(atlas).not.toContain('function symbol499()');
    expect(estimateTokens(atlas)).toBeLessThanOrEqual(12_000);

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('creates task_slice.md with user task, ranked relevant files, tests, and compact docs excerpts', () => {
    const { fixture } = buildFixtureInput();
    const taskSlice = fs.readFileSync(path.join(fixture.flashDir, 'task_slice.md'), 'utf8');

    expect(taskSlice).toContain('Fix compact flash input for prompt pipeline');
    expect(taskSlice).toContain('## Ranked Relevant Files');
    expect(taskSlice).toContain('src/core/context/flash_input_builder.ts');
    expect(taskSlice).toContain('## Ranked Relevant Tests');
    expect(taskSlice).toContain('tests/core/context.test.ts');
    expect(taskSlice).toContain('## Ranked Relevant Docs / Instructions');
    expect(taskSlice).toContain('AGENTS.md');
    expect(taskSlice).toContain('Do not expose secrets');
    expect(estimateTokens(taskSlice)).toBeLessThanOrEqual(24_000);

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('renders doc headings text when scan docs headings are objects instead of leaking [object Object]', () => {
    const fixture = makeRunFixture();
    fs.writeFileSync(
      path.join(fixture.runDir, 'scan', 'docs.json'),
      JSON.stringify({
        docs: [
          {
            path: 'docs/CONTEXT.md',
            headings: [
              { text: 'VibecodeLight Context Architecture', level: 1 },
              { text: 'Purpose', level: 2 },
            ],
            excerpt: 'Context architecture excerpt.',
          },
        ],
      }),
      'utf8',
    );

    const manifest = buildFlashInputManifest({
      run_id: fixture.runId,
      task: 'Render doc headings correctly',
      repo_root: fixture.repoRoot,
      runDir: fixture.runDir,
    });
    buildFlashInput({
      run_id: fixture.runId,
      task: 'Render doc headings correctly',
      repo_root: fixture.repoRoot,
      runDir: fixture.runDir,
      manifest,
    });

    const taskSlice = fs.readFileSync(path.join(fixture.flashDir, 'task_slice.md'), 'utf8');
    expect(taskSlice).toContain('VibecodeLight Context Architecture, Purpose');
    expect(taskSlice).not.toContain('[object Object]');

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('writes relevance_selection.json with scores, reasons, selected symbol and import counts', () => {
    const { fixture } = buildFixtureInput();
    const selection = JSON.parse(fs.readFileSync(path.join(fixture.flashDir, 'relevance_selection.json'), 'utf8'));

    expect(selection.selected_files[0]).toMatchObject({ path: 'src/core/context/flash_input_builder.ts' });
    expect(selection.selected_files[0].score).toBeGreaterThan(0);
    expect(selection.selected_files[0].reasons.length).toBeGreaterThan(0);
    expect(selection.selected_tests[0].path).toBe('tests/core/context.test.ts');
    expect(selection.selected_symbols.count).toBeLessThanOrEqual(200);
    expect(selection.selected_import_edges.count).toBeLessThanOrEqual(100);
    expect(selection.excluded_large_sections).toEqual(expect.arrayContaining(['full symbols dump', 'full imports dump', 'full file inventory']));

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('prioritizes exact text hit files above generic ranked files and explains the evidence', () => {
    const fixture = makeRunFixture();
    const exactText = 'Translates and expands your task into English search hints before context selection. Does not select files.';
    fs.writeFileSync(
      path.join(fixture.runDir, 'scan', 'exact_text_hits.json'),
      JSON.stringify({
        task: `odstraň z GUI popis task normalizeru - (${exactText})`,
        exact_phrases: [{ text: exactText, normalized_text: exactText, source: 'parenthesized' }],
        exact_text_hits: [
          {
            term: exactText,
            provenance: 'exact_phrase',
            match_type: 'exact_text',
            path: 'src/app/desktop/renderer/index.html',
            line: 144,
            excerpt: exactText,
          },
        ],
      }),
      'utf8',
    );

    const manifest = buildFlashInputManifest({
      run_id: fixture.runId,
      task: `odstraň z GUI popis task normalizeru - (${exactText})`,
      repo_root: fixture.repoRoot,
      runDir: fixture.runDir,
    });
    buildFlashInput({
      run_id: fixture.runId,
      task: `odstraň z GUI popis task normalizeru - (${exactText})`,
      repo_root: fixture.repoRoot,
      runDir: fixture.runDir,
      manifest,
      taskIntent: {
        enabled: true,
        ok: true,
        source: 'llm',
        original_task: `odstraň z GUI popis task normalizeru - (${exactText})`,
        original_language: 'cs',
        normalized_english_task: 'Remove task normalizer description from GUI settings switch',
        search_hints: ['task normalizer settings switch renderer'],
        keyword_groups: {
          core_terms: [],
          ui_terms: ['settings', 'switch', 'renderer'],
          persistence_terms: [],
          cli_terms: [],
          test_terms: [],
        },
        negative_constraints: [],
        validation_hints: [],
        uncertainties: [],
        warnings: [],
        model: { provider: 'mock', model: 'mock', live: false },
      },
    });

    const selection = JSON.parse(fs.readFileSync(path.join(fixture.flashDir, 'relevance_selection.json'), 'utf8'));
    const taskSlice = fs.readFileSync(path.join(fixture.flashDir, 'task_slice.md'), 'utf8');

    expect(selection.selected_files[0].path).toBe('src/app/desktop/renderer/index.html');
    expect(selection.selected_files[0].reasons).toContain(`exact text match: "${exactText}"`);
    expect(taskSlice).toContain(`src/app/desktop/renderer/index.html — selected by: exact text match: "${exactText}"`);
    expect(taskSlice).not.toMatch(/score \d+/i);

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('flash_input.md uses Repo Atlas and Task Slice and does not embed full scan dumps', () => {
    const { fixture, content } = buildFixtureInput();

    expect(content).toMatch(/^# Task$/m);
    expect(content).toMatch(/^# Repo Atlas$/m);
    expect(content).toMatch(/^# Task Slice$/m);
    expect(content).toMatch(/^# Available Full Artifacts$/m);
    expect(content).toMatch(/^# Flash Instructions$/m);
    expect(content).toContain('scan/file_inventory.json');
    expect(content).toContain('scan/symbols.json');
    expect(content).toContain('scan/imports.json');
    expect(content).not.toMatch(/^# Symbols$/m);
    expect(content).not.toMatch(/^# Imports$/m);
    expect(content).not.toMatch(/^# File Inventory Summary$/m);
    expect(content).not.toMatch(/^# Architecture Documents$/m);
    expect(content).not.toContain('function symbol499()');
    expect(estimateTokens(content)).toBeLessThanOrEqual(32_000);

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('writes flash_input_budget.json with summarized and excluded large sections', () => {
    const { fixture, content } = buildFixtureInput();
    const budget = JSON.parse(fs.readFileSync(path.join(fixture.flashDir, 'flash_input_budget.json'), 'utf8'));

    expect(budget.target_tokens).toBe(24_000);
    expect(budget.hard_max_tokens).toBe(32_000);
    expect(budget.estimated_tokens).toBe(estimateTokens(content));
    expect(budget.budget_status).toBe('ok');
    expect(budget.provider_called).toBe(false);
    expect(budget.section_breakdown).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Repo Atlas' }), expect.objectContaining({ title: 'Task Slice' })]));
    expect(budget.summarized_sections).toEqual(expect.arrayContaining(['Symbols', 'Imports', 'File Inventory', 'Docs']));
    expect(budget.excluded_sections).toEqual(expect.arrayContaining(['full Symbols dump', 'full Imports dump', 'full File Inventory dump', 'full Architecture Documents dump']));

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('does not write API keys or env values to compact artifacts', () => {
    const { fixture } = buildFixtureInput();
    const files = ['repo_atlas.md', 'task_slice.md', 'flash_input_budget.json', 'relevance_selection.json'];
    for (const file of files) {
      const text = fs.readFileSync(path.join(fixture.flashDir, file), 'utf8');
      expect(text).not.toContain('sk-live-secret');
      expect(text).not.toMatch(/api[_-]?key\s*[:=]/i);
    }

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });

  test('writes flash_input_budget.json and throws FLASH_INPUT_BUDGET_EXCEEDED on an oversized compact fixture', () => {
    const fixture = makeRunFixture();
    const selectedHugePath = 'src/' + 'very-long-subsystem-name/'.repeat(120) + 'flash_context_file.ts';
    const selectedHugeTarget = 'src/' + 'dependency-edge/'.repeat(120) + 'target.ts';
    fs.writeFileSync(
      path.join(fixture.runDir, 'scan', 'file_inventory.json'),
      JSON.stringify(
        Array.from({ length: 240 }, (_, index) => ({
          path: index < 200
            ? selectedHugePath
            : `atlas-top-level-${index}-${'very-long-root-name-'.repeat(80)}/module-${index}/entry.ts`,
          size_bytes: 1234,
          language: 'typescript',
        })),
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixture.runDir, 'scan', 'symbols.json'),
      JSON.stringify(
        {
          symbols: Array.from({ length: 180 }, (_, index) => ({
            path: selectedHugePath,
            name: `symbol${index}`,
            signature: `function symbol${index}(${`argumentName${index}`.repeat(12)}): ${`ReturnType${index}`.repeat(10)}`,
            line: index + 1,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixture.runDir, 'scan', 'imports.json'),
      JSON.stringify(
        {
          imports: Array.from({ length: 100 }, (_, index) => ({
            path: selectedHugePath,
            target: `${selectedHugeTarget}.${index}`,
            kind: 'local',
            line: index + 1,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixture.runDir, 'scan', 'docs.json'),
      JSON.stringify(
        {
          docs: Array.from({ length: 8 }, (_, index) => ({
            path: `docs/flash-guide-${index}.md`,
            headings: Array.from({ length: 8 }, (_, headingIndex) => `Heading ${index}-${headingIndex}`),
            excerpt: (`This is a deliberately large excerpt for compact flash budgeting. `.repeat(120)) + index,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );

    const manifest = buildFlashInputManifest({
      run_id: fixture.runId,
      task: 'Fix compact flash input for prompt pipeline',
      repo_root: fixture.repoRoot,
      runDir: fixture.runDir,
    });

    expect(() =>
      buildFlashInput({
        run_id: fixture.runId,
        task: 'Fix compact flash input for prompt pipeline',
        repo_root: fixture.repoRoot,
        runDir: fixture.runDir,
        manifest,
      }),
    ).toThrow(/FLASH_INPUT_BUDGET_EXCEEDED|hard max/i);

    const budget = JSON.parse(fs.readFileSync(path.join(fixture.flashDir, 'flash_input_budget.json'), 'utf8'));
    expect(budget.budget_status).toBe('FLASH_INPUT_BUDGET_EXCEEDED');
    expect(budget.provider_called).toBe(false);
    expect(budget.estimated_tokens).toBeGreaterThan(32_000);

    fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
  });
});
