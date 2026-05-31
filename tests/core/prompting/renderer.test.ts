import fs from 'fs';
import os from 'os';
import path from 'path';

import { renderFinalPrompt, PromptRenderError } from '../../../src/core/prompting/renderer.js';

function makeRunDir(tmpDir: string, opts?: {
  noContextPack?: boolean;
  noSelectedSkills?: boolean;
  emptySkillContents?: boolean;
  withSkillContents?: boolean;
  withFlashMeta?: boolean;
  withTaskSummary?: string;
  withConstraints?: string[];
  withValidationHints?: string[];
  withFlashOutputTaskSummary?: string;
  withTaskIntent?: boolean;
  withScanCommands?: boolean;
  withRepoInstructions?: boolean;
  withArchDocs?: boolean;
  withGitStatus?: boolean;
  withExactTextMatches?: boolean;
  withScanExactTextHits?: boolean;
}): string {
  const runId = 'test-run-001';
  const runDir = path.join(tmpDir, runId);

  // required: user_prompt.md
  fs.writeFileSync(path.join(runDir, 'user_prompt.md'), 'Implement the feature X.\n', 'utf8');

  // required: run_manifest.json
  const manifest = {
    run_id: runId,
    created_at: '2025-01-01T00:00:00.000Z',
    task: 'Implement the feature X.',
    status: 'done',
  };
  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // required: output/context_pack.md
  if (!opts?.noContextPack) {
    fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'output', 'context_pack.md'),
      '## Product Shape\n\nContext content here.\n\n## Top-Level Directory Map\n\n- src/\n',
      'utf8',
    );
  }

  // required: skills/selected_skills.json
  if (!opts?.noSelectedSkills) {
    fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'skills', 'selected_skills.json'),
      JSON.stringify(
        opts?.withSkillContents
          ? { selected_skills: ['test-skill'], warnings: [], missing_skills: [] }
          : { selected: [], warnings: [], missing_skills: [] },
        null, 2,
      ) + '\n',
      'utf8',
    );
  }

  // required: skills/selected_skill_contents.md
  if (!opts?.noSelectedSkills) {
    if (opts?.withSkillContents) {
      fs.writeFileSync(
        path.join(runDir, 'skills', 'selected_skill_contents.md'),
        '# Skill: test-skill\n\nFollow these steps:\n1. Do A\n2. Do B\n',
        'utf8',
      );
    } else {
      // empty skill contents
      fs.writeFileSync(path.join(runDir, 'skills', 'selected_skill_contents.md'), '', 'utf8');
    }
  }

  // optional: flash/flash_output_meta.json
  if (opts?.withFlashMeta) {
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    const meta = {
      selected_skills: ['test-skill'],
      relevant_files: ['src/core/feature.ts'],
      files_to_read_with_tools: ['docs/ARCHITECTURE.md'],
      relevant_tests: ['tests/core/feature.test.ts'],
      commands_to_run: ['pnpm test', 'pnpm exec tsc --noEmit'],
      cautions: ['Do not break the public API.'],
      ...(opts.withTaskSummary ? { task_summary: opts.withTaskSummary } : {}),
      ...(opts.withConstraints ? { constraints: opts.withConstraints } : {}),
      ...(opts.withValidationHints ? { validation_hints: opts.withValidationHints } : {}),
      warnings: [],
    };
    fs.writeFileSync(path.join(runDir, 'flash', 'flash_output_meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }

  // optional: flash/relevance_selection.json
  if (opts?.withExactTextMatches) {
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    const relevanceSelection = {
      selected_files: [
        {
          path: 'src/app/desktop/renderer/index.html',
          score: 101000,
          reasons: ['exact text match: "Translates and expands your task into English search hints"'],
        },
      ],
      selected_tests: [],
      selected_docs: [],
    };
    fs.writeFileSync(
      path.join(runDir, 'flash', 'relevance_selection.json'),
      JSON.stringify(relevanceSelection, null, 2) + '\n',
      'utf8',
    );
  }

  // optional: scan/exact_text_hits.json
  if (opts?.withScanExactTextHits) {
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    const exactTextHits = {
      exact_text_hits: [
        {
          term: 'Translates and expands your task into English search hints before context selection. Does not select files.',
          source: 'parenthesized',
          match_type: 'exact_text',
          path: 'src/app/desktop/renderer/index.html',
          line: 114,
          excerpt: 'title="Translates and expands your task into English search hints before context selection. Does not select files."',
        },
      ],
      warnings: [],
    };
    fs.writeFileSync(
      path.join(runDir, 'scan', 'exact_text_hits.json'),
      JSON.stringify(exactTextHits, null, 2) + '\n',
      'utf8',
    );
  }

  // optional: flash/flash_output.md containing a Task Summary that should not be
  // used as a renderer fallback. The current renderer only trusts flash_output_meta.json.
  if (opts?.withFlashOutputTaskSummary) {
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'flash', 'flash_output.md'),
      [
        '# Task Summary',
        opts.withFlashOutputTaskSummary,
        '',
        '# Relevant Files',
        '- src/core/feature.ts',
        '',
        '# Files To Read With Tools',
        '- docs/ARCHITECTURE.md',
        '',
        '# Relevant Tests',
        '- tests/core/feature.test.ts',
        '',
        '# Commands To Run',
        '- pnpm test',
        '',
        '# Selected Skills',
        '- test-skill',
        '',
        '# Cautions',
        '- Do not break the public API.',
        '',
        '# Context Pack',
        '## Product Shape',
        'Context content here.',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  // optional: task_intent.json from Task Normalizer.
  if (opts?.withTaskIntent) {
    const taskIntent = {
      enabled: true,
      ok: true,
      source: 'llm',
      original_task: 'Implement the feature X.',
      original_language: 'cs',
      normalized_english_task: 'Remove the Task Normalizer description from the GUI and keep only the toggle switch.',
      search_hints: ['GUI', 'task normalizer', 'toggle switch'],
      keyword_groups: { core_terms: ['task normalizer'], ui_terms: ['toggle switch'] },
      negative_constraints: ['do not remove the toggle switch'],
      validation_hints: ['verify the Task Normalizer toggle remains visible'],
      uncertainties: [],
      warnings: [],
    };
    fs.writeFileSync(path.join(runDir, 'task_intent.json'), JSON.stringify(taskIntent, null, 2) + '\n', 'utf8');
  }

  // optional: scan/commands.json
  if (opts?.withScanCommands) {
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    const commands = { commands: ['pnpm lint', 'pnpm test'] };
    fs.writeFileSync(path.join(runDir, 'scan', 'commands.json'), JSON.stringify(commands, null, 2) + '\n', 'utf8');
  }

  // optional: scan/repo_instructions.json
  if (opts?.withRepoInstructions) {
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    const instructions = { files: ['AGENTS.md', 'docs/ARCHITECTURE.md'] };
    fs.writeFileSync(path.join(runDir, 'scan', 'repo_instructions.json'), JSON.stringify(instructions, null, 2) + '\n', 'utf8');
  }

  return runDir;
}

describe('renderFinalPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-renderer-test-'));
    // create run subdirectory
    const runId = 'test-run-001';
    fs.mkdirSync(path.join(tmpDir, runId), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('renderer writes output/final_prompt.md from a finalized run', () => {
    const runDir = makeRunDir(tmpDir);
    const result = renderFinalPrompt(runDir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'output', 'final_prompt.md'))).toBe(true);
  });

  test('final_prompt.md includes original user task', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('Implement the feature X.');
  });

  test('final_prompt.md includes context_pack.md content', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('Context content here.');
  });

  test('final_prompt.md includes selected_skill_contents.md content when present', () => {
    const runDir = makeRunDir(tmpDir, { withSkillContents: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('Follow these steps:');
  });

  test('final_prompt.md explicitly handles empty selected skills', () => {
    const runDir = makeRunDir(tmpDir); // emptySkillContents by default
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toMatch(/no selected skills/i);
  });

  test('final_prompt.md includes relevant files from flash metadata when present', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('src/core/feature.ts');
  });

  test('final_prompt.md includes files to inspect from flash metadata when present', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('docs/ARCHITECTURE.md');
  });

  test('final_prompt.md preserves flash task summary before repo atlas content', () => {
    const taskSummary = 'Remove the task normalizer description text from the GUI and retain only the toggle switch.';
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true, withTaskSummary: taskSummary });

    renderFinalPrompt(runDir);

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('## Task Summary');
    expect(content).toContain(taskSummary);
    expect(content.indexOf('## Task Summary')).toBeLessThan(content.indexOf('## Product Shape'));
  });

  test('final_prompt.md renders constraints and validation hints from flash metadata', () => {
    const taskSummary = 'Remove the task normalizer description text from the GUI and retain only the toggle switch.';
    const runDir = makeRunDir(tmpDir, {
      withFlashMeta: true,
      withTaskSummary: taskSummary,
      withConstraints: ['do not remove the toggle switch'],
      withValidationHints: ['verify the Task Normalizer toggle remains visible'],
      withExactTextMatches: true,
    });

    renderFinalPrompt(runDir);

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('## Constraints');
    expect(content).toContain('- do not remove the toggle switch');
    expect(content).toContain('## Validation Hints');
    expect(content).toContain('- verify the Task Normalizer toggle remains visible');
    expect(content.indexOf('## Task Summary')).toBeLessThan(content.indexOf('## Constraints'));
    expect(content.indexOf('## Constraints')).toBeLessThan(content.indexOf('## Validation Hints'));
    expect(content.indexOf('## Validation Hints')).toBeLessThan(content.indexOf('## Exact Text Matches'));
    expect(content.indexOf('## Exact Text Matches')).toBeLessThan(content.indexOf('## Product Shape'));
  });

  test('final_prompt.md does not parse flash_output.md as a task summary fallback', () => {
    const taskSummary = 'Remove the task normalizer description text from the GUI and retain only the toggle switch.';
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true, withFlashOutputTaskSummary: taskSummary });

    renderFinalPrompt(runDir);

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).not.toContain(`## Task Summary\n${taskSummary}`);
    expect(content).toContain('## Renderer Warnings');
    expect(content).toContain('Missing task_summary in flash_output_meta.json.');
  });

  test('final_prompt.md does not use Task Normalizer intent as a missing task summary fallback', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true, withTaskIntent: true, withExactTextMatches: true });

    renderFinalPrompt(runDir);

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).not.toContain('## Task Summary\nRemove the Task Normalizer description from the GUI and keep only the toggle switch.');
    expect(content).toContain('## Renderer Warnings');
    expect(content).toContain('Missing task_summary in flash_output_meta.json.');
    expect(content.indexOf('## Exact Text Matches')).toBeLessThan(content.indexOf('## Product Shape'));
  });

  test('final_prompt.md renders exact text matches in a dedicated context pack section before relevant files', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true, withExactTextMatches: true });

    renderFinalPrompt(runDir);

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    const exactLine = '- src/app/desktop/renderer/index.html — exact text match: "Translates and expands your task into English search hints"';

    expect(content).toContain('## Exact Text Matches');
    expect(content).toContain(exactLine);
    expect(content.indexOf('## Exact Text Matches')).toBeLessThan(content.indexOf('## Relevant Files'));
  });

  test('final_prompt.md renders exact text matches from scan exact_text_hits.json', () => {
    const taskSummary = 'Remove the task normalizer description text from the GUI and retain only the toggle switch.';
    const runDir = makeRunDir(tmpDir, {
      withFlashMeta: true,
      withTaskSummary: taskSummary,
      withScanExactTextHits: true,
    });

    renderFinalPrompt(runDir);

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('## Exact Text Matches');
    expect(content).toContain('src/app/desktop/renderer/index.html');
    expect(content).toContain('exact text match');
  });

  test('final_prompt.md shows explicit renderer warning when flash meta omits task_summary', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });

    const result = renderFinalPrompt(runDir);

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('Missing task_summary in flash_output_meta.json.');
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).not.toContain('## Task Summary');
    expect(content).toContain('## Renderer Warnings');
    expect(content).toContain('- Missing task_summary in flash_output_meta.json.');
    expect(content).toContain('## Product Shape');
  });

  test('final_prompt.md does not start context pack with repo atlas headings when task summary exists', () => {
    const taskSummary = 'Remove the task normalizer description text from the GUI and retain only the toggle switch.';
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true, withTaskSummary: taskSummary });

    renderFinalPrompt(runDir);

    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    const contextPackStart = content.indexOf('# Context Pack');
    const afterContextPack = content.slice(contextPackStart);
    const headingMatches = [...afterContextPack.matchAll(/^## .+$/gm)];
    const firstH2 = headingMatches[0]?.[0];

    expect(firstH2).toBeDefined();
    expect(firstH2).not.toBe('## Product Shape');
    expect(firstH2).not.toBe('## Top-Level Directory Map');
  });

  test('final_prompt.md prepends exact text match files from deterministic relevance selection', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    const exactText = 'Translates and expands your task into English search hints before context selection. Does not select files.';
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'flash', 'relevance_selection.json'),
      JSON.stringify({
        selected_files: [
          {
            path: 'src/app/desktop/renderer/index.html',
            score: 10000,
            reasons: [`exact text match: "${exactText}"`],
          },
          {
            path: 'src/app/desktop/renderer/flash_settings.js',
            score: 80,
            reasons: ['path matches task term settings'],
          },
        ],
      }, null, 2),
      'utf8',
    );

    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    const exactLine = `- src/app/desktop/renderer/index.html — exact text match: "${exactText}"`;

    expect(content).toContain(exactLine);
    expect(content.indexOf(exactLine)).toBeLessThan(content.indexOf('- src/core/feature.ts'));
    expect(content).toContain('## Files To Inspect');
    expect(content).toContain('src/app/desktop/renderer/index.html');
    expect(content).not.toMatch(/score 10000/i);
  });

  test('final_prompt.md includes commands from flash metadata', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('pnpm test');
    expect(content).toContain('pnpm exec tsc --noEmit');
  });

  test('final_prompt.md includes commands from scan/commands.json when flash meta absent', () => {
    const runDir = makeRunDir(tmpDir, { withScanCommands: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('pnpm lint');
  });

  test('final_prompt.md includes cautions when present', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('Do not break the public API.');
  });

  test('final_prompt.md includes repository instruction references when available', () => {
    const runDir = makeRunDir(tmpDir, { withRepoInstructions: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toContain('AGENTS.md');
  });

  test('final_prompt.md includes validation expectations and final report requirements', () => {
    const runDir = makeRunDir(tmpDir);
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(content).toMatch(/# Validation Expectations/i);
    expect(content).toMatch(/# Output Requirements/i);
  });

  test('renderer is deterministic for the same input artifacts', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true, withSkillContents: true });
    renderFinalPrompt(runDir);
    const first = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    renderFinalPrompt(runDir);
    const second = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    expect(first).toBe(second);
  });

  test('missing required context_pack.md fails with structured diagnostic', () => {
    const runDir = makeRunDir(tmpDir, { noContextPack: true });
    const result = renderFinalPrompt(runDir);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('CONTEXT_PACK_NOT_FOUND');
  });

  test('missing optional scan/commands.json produces warning, not crash', () => {
    const runDir = makeRunDir(tmpDir); // no scan commands
    const result = renderFinalPrompt(runDir);
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => w.includes('commands.json') || w.includes('commands'))).toBe(false);
    // should succeed without crash
  });

  test('prompt render updates .vibecode/current/final_prompt.md', () => {
    const runDir = makeRunDir(tmpDir);
    const vibecodePath = path.join(tmpDir, '.vibecode');
    fs.mkdirSync(path.join(vibecodePath, 'current'), { recursive: true });

    renderFinalPrompt(runDir, { vibecodePath });
    expect(fs.existsSync(path.join(vibecodePath, 'current', 'final_prompt.md'))).toBe(true);
  });

  test('prompt render updates .vibecode/current/context_pack.md', () => {
    const runDir = makeRunDir(tmpDir);
    const vibecodePath = path.join(tmpDir, '.vibecode');
    fs.mkdirSync(path.join(vibecodePath, 'current'), { recursive: true });

    renderFinalPrompt(runDir, { vibecodePath });
    expect(fs.existsSync(path.join(vibecodePath, 'current', 'context_pack.md'))).toBe(true);
  });

  test('prompt render updates .vibecode/current/selected_skills.json', () => {
    const runDir = makeRunDir(tmpDir);
    const vibecodePath = path.join(tmpDir, '.vibecode');
    fs.mkdirSync(path.join(vibecodePath, 'current'), { recursive: true });

    renderFinalPrompt(runDir, { vibecodePath });
    expect(fs.existsSync(path.join(vibecodePath, 'current', 'selected_skills.json'))).toBe(true);
  });

  test('prompt render does not create terminal/send_metadata.json', () => {
    const runDir = makeRunDir(tmpDir);
    const vibecodePath = path.join(tmpDir, '.vibecode');
    fs.mkdirSync(path.join(vibecodePath, 'current'), { recursive: true });

    renderFinalPrompt(runDir, { vibecodePath });
    expect(fs.existsSync(path.join(runDir, 'terminal', 'send_metadata.json'))).toBe(false);
    expect(fs.existsSync(path.join(vibecodePath, 'current', 'send_metadata.json'))).toBe(false);
  });

  test('prompt render does not call flash model (no flash output mutation)', () => {
    const runDir = makeRunDir(tmpDir);
    // No flash/flash_output.md exists - renderer must not create it
    renderFinalPrompt(runDir);
    expect(fs.existsSync(path.join(runDir, 'flash', 'flash_output.md'))).toBe(false);
  });

  test('prompt render does not rescan the repository', () => {
    const runDir = makeRunDir(tmpDir);
    // Scan dir not created initially - renderer must not create scan artifacts
    const scanBefore = fs.existsSync(path.join(runDir, 'scan'));
    renderFinalPrompt(runDir);
    const scanAfter = fs.existsSync(path.join(runDir, 'scan'));
    // scan dir existence should not change (renderer doesn't create it if absent)
    expect(scanAfter).toBe(scanBefore);
  });

  test('final_prompt.md has stable required section headers', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');
    // Top-level sections (single #)
    expect(content).toMatch(/^# Task$/m);
    expect(content).toMatch(/^# Repository Context$/m);
    expect(content).toMatch(/^# Context Pack$/m);
    expect(content).toMatch(/^# Selected Skills$/m);
    expect(content).toMatch(/^# Repository Instructions$/m);
    expect(content).toMatch(/^# Validation Expectations$/m);
    expect(content).toMatch(/^# Output Requirements$/m);
    // Task-specific lists live only under Context Pack (## headings)
    expect(content).toMatch(/^## Relevant Files$/m);
    expect(content).toMatch(/^## Files To Inspect$/m);
    expect(content).toMatch(/^## Suggested Commands$/m);
    expect(content).toMatch(/^## Cautions$/m);
    // And must not be duplicated at the top level
    expect(content).not.toMatch(/^# Relevant Files$/m);
    expect(content).not.toMatch(/^# Files To Inspect$/m);
    expect(content).not.toMatch(/^# Suggested Commands$/m);
    expect(content).not.toMatch(/^# Cautions$/m);
  });

  test('renders without crash when commands.json has object-shaped commands (real scanner format)', () => {
    // The Python scanner writes commands as an object { install:[...], run:[...], test:[...] }
    // not a flat array. The renderer must handle this gracefully without crashing.
    const runDir = makeRunDir(tmpDir);
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    const objectShapedCommands = {
      commands: {
        install: [{ command: 'pnpm install', source: 'package.json' }],
        run: [],
        test: [{ command: 'pnpm test', source: 'package.json' }],
      },
    };
    fs.writeFileSync(
      path.join(runDir, 'scan', 'commands.json'),
      JSON.stringify(objectShapedCommands, null, 2) + '\n',
      'utf8',
    );
    const result = renderFinalPrompt(runDir);
    expect(result.ok).toBe(true);
  });

  test('renders without crash when repo_instructions.json has object-shaped entries (real scanner format)', () => {
    // The Python scanner writes repo_instructions as an array of objects {path, content, headings}
    // not a flat string array. The renderer must handle this gracefully.
    const runDir = makeRunDir(tmpDir);
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    const objectShapedInstructions = {
      repo_instructions: [
        { path: 'AGENTS.md', content: '# AGENTS', headings: [] },
      ],
    };
    fs.writeFileSync(
      path.join(runDir, 'scan', 'repo_instructions.json'),
      JSON.stringify(objectShapedInstructions, null, 2) + '\n',
      'utf8',
    );
    const result = renderFinalPrompt(runDir);
    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Dedupe / filtering / empty-section regression tests
  // -------------------------------------------------------------------------

  test('final_prompt.md does not duplicate Relevant Files / Files To Inspect / Suggested Commands / Cautions at top level', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');

    const countMatches = (re: RegExp) => (content.match(re) ?? []).length;
    expect(countMatches(/^## Relevant Files$/gm)).toBe(1);
    expect(countMatches(/^## Files To Inspect$/gm)).toBe(1);
    expect(countMatches(/^## Suggested Commands$/gm)).toBe(1);
    expect(countMatches(/^## Cautions$/gm)).toBe(1);
    expect(countMatches(/^# Relevant Files$/gm)).toBe(0);
    expect(countMatches(/^# Files To Inspect$/gm)).toBe(0);
    expect(countMatches(/^# Suggested Commands$/gm)).toBe(0);
    expect(countMatches(/^# Cautions$/gm)).toBe(0);
  });

  test('final_prompt.md filters exact text evidence: prefers implementation, drops prompt-system self-tests, deduplicates lines', () => {
    const runDir = makeRunDir(tmpDir, { withFlashMeta: true });
    const term =
      'Translates and expands your task into English search hints before context selection. Does not select files.';

    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'scan', 'exact_text_hits.json'),
      JSON.stringify(
        {
          exact_text_hits: [
            { term, path: 'src/app/desktop/renderer/index.html', line: 114, match_type: 'exact_text' },
            { term, path: 'src/app/desktop/renderer/index.html', line: 120, match_type: 'exact_text' },
            { term, path: 'tests/app/desktop/flash_settings_task_normalizer.test.ts', line: 27, match_type: 'exact_text' },
            { term, path: 'tests/core/compact_flash_input.test.ts', line: 168, match_type: 'exact_text' },
            { term, path: 'tests/core/prompting/renderer.test.ts', line: 124, match_type: 'exact_text' },
            { term, path: 'tests/core/prompting/renderer.test.ts', line: 129, match_type: 'exact_text' },
            { term, path: 'tests/integration/context_build.test.ts', line: 118, match_type: 'exact_text' },
          ],
          warnings: [],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    // Mark the desktop test as a relevant test so it qualifies as a related test match.
    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    const meta = {
      selected_skills: ['test-skill'],
      relevant_files: ['src/app/desktop/renderer/index.html'],
      files_to_read_with_tools: [],
      relevant_tests: ['tests/app/desktop/flash_settings_task_normalizer.test.ts'],
      commands_to_run: ['pnpm exec tsc --noEmit'],
      cautions: [],
      task_summary: 'Remove the description text. Keep the toggle.',
      warnings: [],
    };
    fs.writeFileSync(
      path.join(runDir, 'flash', 'flash_output_meta.json'),
      JSON.stringify(meta, null, 2) + '\n',
      'utf8',
    );

    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');

    // Implementation primary match present, lines grouped.
    expect(content).toContain('src/app/desktop/renderer/index.html');
    expect(content).toMatch(/src\/app\/desktop\/renderer\/index\.html \(lines 114, 120\)/);

    // Related desktop test included only because it's in relevant_tests.
    expect(content).toContain('tests/app/desktop/flash_settings_task_normalizer.test.ts');

    // Prompt-system self-tests are NOT in relevant_tests → excluded.
    expect(content).not.toContain('tests/core/prompting/renderer.test.ts');
    expect(content).not.toContain('tests/core/compact_flash_input.test.ts');
    expect(content).not.toContain('tests/integration/context_build.test.ts');

    // Omission marker appears because hits were dropped.
    expect(content).toContain('Additional exact matches omitted; see scan/exact_text_hits.json.');

    // Lines for the same path are grouped on one bullet inside Exact Text Matches.
    const exactSection = content.slice(
      content.indexOf('## Exact Text Matches'),
      content.indexOf('## Relevant Files'),
    );
    const indexHtmlBullets = (exactSection.match(/^- src\/app\/desktop\/renderer\/index\.html\b/gm) ?? []).length;
    expect(indexHtmlBullets).toBe(1);
  });

  test('final_prompt.md omits empty Constraints and Validation Hints sections', () => {
    const runDir = makeRunDir(tmpDir, {
      withFlashMeta: true,
      withTaskSummary: 'Trivial task summary.',
      // no constraints, no validation hints
    });
    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');

    expect(content).not.toMatch(/^## Constraints$/m);
    expect(content).not.toMatch(/^## Validation Hints$/m);
    expect(content).not.toContain('_None_');
  });

  test('final_prompt.md regression for the Czech task normalizer prompt is concise and well-structured', () => {
    const term =
      'Translates and expands your task into English search hints before context selection. Does not select files.';
    const taskSummary =
      'Remove the description text "' + term + '" from the GUI settings panel. Keep only the existing toggle switch for the task normalizer feature.';

    const runDir = path.join(tmpDir, 'test-run-001');
    fs.writeFileSync(
      path.join(runDir, 'user_prompt.md'),
      'odstraň z GUI popis task normalizeru - (' + term + ')\nNechci tam žádný popis task normalizeru, jen ten přepínač co tam je teď\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'run_manifest.json'),
      JSON.stringify(
        { run_id: 'test-run-001', created_at: '2026-05-31T00:00:00.000Z', task: 'task', status: 'done' },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'output', 'context_pack.md'),
      '## Task Slice\n\nRemove the description of the task normalizer.\n\n## Repo Atlas Summary\n\nVibecodeLight is an Electron/TypeScript desktop + CLI workspace.\n',
      'utf8',
    );
    fs.mkdirSync(path.join(runDir, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'skills', 'selected_skills.json'),
      JSON.stringify({ selected: [], warnings: [], missing_skills: [] }, null, 2) + '\n',
      'utf8',
    );
    fs.writeFileSync(path.join(runDir, 'skills', 'selected_skill_contents.md'), '', 'utf8');

    fs.mkdirSync(path.join(runDir, 'flash'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'flash', 'flash_output_meta.json'),
      JSON.stringify(
        {
          selected_skills: [],
          relevant_files: ['src/app/desktop/renderer/index.html', 'tests/app/desktop/flash_settings_task_normalizer.test.ts'],
          files_to_read_with_tools: [],
          relevant_tests: ['tests/app/desktop/flash_settings_task_normalizer.test.ts'],
          commands_to_run: [
            'pnpm exec tsc --noEmit',
            'pnpm lint',
            'pnpm test -- tests/app/desktop/flash_settings_task_normalizer.test.ts',
          ],
          cautions: [
            'Do not remove the toggle switch itself, only the descriptive text associated with it.',
          ],
          task_summary: taskSummary,
          constraints: [],
          validation_hints: [],
          warnings: [],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'flash', 'relevance_selection.json'),
      JSON.stringify(
        {
          selected_files: [
            { path: 'src/app/desktop/renderer/index.html', reasons: [`exact text match: "${term}"`] },
            { path: 'tests/app/desktop/flash_settings_task_normalizer.test.ts', reasons: [`exact text match: "${term}"`] },
            { path: 'tests/core/compact_flash_input.test.ts', reasons: [`exact text match: "${term}"`] },
            { path: 'tests/core/prompting/renderer.test.ts', reasons: [`exact text match: "${term}"`] },
            { path: 'tests/integration/context_build.test.ts', reasons: [`exact text match: "${term}"`] },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    fs.mkdirSync(path.join(runDir, 'scan'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'scan', 'exact_text_hits.json'),
      JSON.stringify(
        {
          exact_text_hits: [
            { term, path: 'src/app/desktop/renderer/index.html', line: 114, match_type: 'exact_text' },
            { term, path: 'src/app/desktop/renderer/index.html', line: 120, match_type: 'exact_text' },
            { term, path: 'tests/app/desktop/flash_settings_task_normalizer.test.ts', line: 27, match_type: 'exact_text' },
            { term, path: 'tests/core/compact_flash_input.test.ts', line: 168, match_type: 'exact_text' },
            { term, path: 'tests/core/prompting/renderer.test.ts', line: 124, match_type: 'exact_text' },
            { term, path: 'tests/integration/context_build.test.ts', line: 118, match_type: 'exact_text' },
          ],
          warnings: [],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    renderFinalPrompt(runDir);
    const content = fs.readFileSync(path.join(runDir, 'output', 'final_prompt.md'), 'utf8');

    // Has Task Summary and concise Exact Text Matches.
    expect(content).toContain('## Task Summary');
    expect(content).toContain('## Exact Text Matches');

    // index.html is the primary implementation match with grouped lines.
    expect(content).toMatch(/src\/app\/desktop\/renderer\/index\.html \(lines 114, 120\)/);

    // No duplicated top-level sections.
    expect(content).not.toMatch(/^# Relevant Files$/m);
    expect(content).not.toMatch(/^# Files To Inspect$/m);
    expect(content).not.toMatch(/^# Suggested Commands$/m);
    expect(content).not.toMatch(/^# Cautions$/m);

    // Prompt-system self-tests are not surfaced by default.
    expect(content).not.toContain('tests/core/prompting/renderer.test.ts');
    expect(content).not.toContain('tests/core/compact_flash_input.test.ts');
    expect(content).not.toContain('tests/integration/context_build.test.ts');

    // No "_None_" placeholders.
    expect(content).not.toContain('_None_');

    // Repo atlas content appears after task-specific Context Pack sections.
    expect(content.indexOf('## Task Summary')).toBeLessThan(content.indexOf('## Repo Atlas Summary'));
    expect(content.indexOf('## Exact Text Matches')).toBeLessThan(content.indexOf('## Repo Atlas Summary'));
  });
});
