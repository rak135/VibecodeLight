import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  REQUIRED_SECTIONS,
  type FlashOutputSection,
} from '../src/core/context/flash_output_contract.js';
import { parseFlashOutput } from '../src/core/context/markdown_flash_output_parser.js';
import { extractFlashOutputMeta, writeFlashOutputMeta } from '../src/core/context/flash_output_meta.js';

function makeValidMarkdown(): string {
  return REQUIRED_SECTIONS.map((section) => `# ${section}\n${section} body\n`).join('\n');
}

describe('parseFlashOutput', () => {
  test('valid markdown with all sections passes validation', () => {
    const markdown = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'flash_output_valid.md'), 'utf8');
    const result = parseFlashOutput(markdown, 'tests/fixtures/flash_output_valid.md');

    expect(result.ok).toBe(true);
    expect(result.diagnostic).toBeUndefined();
    expect(result.sections.map((section) => section.name)).toEqual([...REQUIRED_SECTIONS]);
  });

  test('parser requires all mandatory top-level sections', () => {
    const result = parseFlashOutput(makeValidMarkdown(), 'tests/fixtures/generated.md');
    expect(result.ok).toBe(true);
  });

  test('missing Task Summary fails with structured diagnostic', () => {
    const markdown = makeValidMarkdown().replace(/^# Task Summary\nTask Summary body\n\n?/m, '');
    const result = parseFlashOutput(markdown, 'tests/fixtures/missing-task-summary.md');

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toBeDefined();
    expect(result.diagnostic?.code).toBe('FLASH_OUTPUT_INVALID');
    expect(result.diagnostic?.details.join(' ')).toContain('Task Summary');
  });

  test('missing Selected Skills fails with structured diagnostic', () => {
    const markdown = makeValidMarkdown().replace(/^# Selected Skills\nSelected Skills body\n\n?/m, '');
    const result = parseFlashOutput(markdown, 'tests/fixtures/missing-selected-skills.md');

    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe('FLASH_OUTPUT_INVALID');
    expect(result.diagnostic?.details.join(' ')).toContain('Selected Skills');
  });

  test('misspelled section heading fails validation', () => {
    const markdown = makeValidMarkdown().replace('# Task Summary', '# Task Sumary');
    const result = parseFlashOutput(markdown, 'tests/fixtures/misspelled.md');

    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe('FLASH_OUTPUT_INVALID');
    expect(result.diagnostic?.details.join(' ')).toContain('Task Summary');
  });

  test('parser preserves raw markdown in result', () => {
    const markdown = '# Task Summary\nalpha\n\n# Relevant Files\nbeta\n';
    const result = parseFlashOutput(markdown, 'tests/fixtures/raw-markdown.md');

    expect(result.rawMarkdown).toBe(markdown);
  });

  test('parser extracts section bodies', () => {
    const markdown = [
      '# Task Summary',
      'alpha',
      '',
      '# Relevant Files',
      '- src/core/context/index.ts',
      '- src/app/cli/index.ts',
      '',
      '# Files To Read With Tools',
      '- src/core/context/markdown_flash_output_parser.ts',
      '',
      '# Relevant Tests',
      '- tests/flash_output_parser.test.ts',
      '',
      '# Commands To Run',
      '- pnpm test',
      '',
      '# Selected Skills',
      '- test-driven-development',
      '',
      '# Cautions',
      '- keep strict',
      '',
      '# Context Pack',
      'omega',
      '',
    ].join('\n');
    const result = parseFlashOutput(markdown, 'tests/fixtures/bodies.md');

    expect(result.ok).toBe(true);
    expect(result.sections.find((section) => section.name === 'Relevant Files')?.body).toContain('src/core/context/index.ts');
    expect(result.sections.find((section) => section.name === 'Context Pack')?.body).toBe('omega\n');
  });

  test('selected_skills list can be extracted from sections', () => {
    const sections: FlashOutputSection[] = [
      { name: 'Selected Skills', body: '- test-driven-development — write tests first\n* subagent-driven-development\n' },
      { name: 'Relevant Files', body: '' },
      { name: 'Files To Read With Tools', body: '' },
      { name: 'Relevant Tests', body: '' },
      { name: 'Commands To Run', body: '' },
      { name: 'Cautions', body: '' },
      { name: 'Context Pack', body: '' },
      { name: 'Task Summary', body: '' },
    ];
    const meta = extractFlashOutputMeta(sections);

    expect(meta.selected_skills).toEqual(['test-driven-development', 'subagent-driven-development']);
  });

  test('task summary can be extracted', () => {
    const meta = extractFlashOutputMeta([
      { name: 'Task Summary', body: '  Remove the task normalizer description and keep only the toggle.\n\n' },
      { name: 'Relevant Files', body: '' },
      { name: 'Files To Read With Tools', body: '' },
      { name: 'Relevant Tests', body: '' },
      { name: 'Commands To Run', body: '' },
      { name: 'Selected Skills', body: '' },
      { name: 'Cautions', body: '' },
      { name: 'Context Pack', body: '' },
    ]);

    expect(meta.task_summary).toBe('Remove the task normalizer description and keep only the toggle.');
  });

  test('relevant_files list can be extracted', () => {
    const meta = extractFlashOutputMeta([
      { name: 'Relevant Files', body: '- src/core/context/index.ts — entry point\n- src/app/cli/index.ts\n' },
      { name: 'Task Summary', body: '' },
      { name: 'Files To Read With Tools', body: '' },
      { name: 'Relevant Tests', body: '' },
      { name: 'Commands To Run', body: '' },
      { name: 'Selected Skills', body: '' },
      { name: 'Cautions', body: '' },
      { name: 'Context Pack', body: '' },
    ]);

    expect(meta.relevant_files).toEqual(['src/core/context/index.ts', 'src/app/cli/index.ts']);
  });

  test('files_to_read_with_tools list can be extracted', () => {
    const meta = extractFlashOutputMeta([
      { name: 'Files To Read With Tools', body: '* src/core/context/markdown_flash_output_parser.ts — parser\n* src/core/context/flash_output_meta.ts\n' },
      { name: 'Task Summary', body: '' },
      { name: 'Relevant Files', body: '' },
      { name: 'Relevant Tests', body: '' },
      { name: 'Commands To Run', body: '' },
      { name: 'Selected Skills', body: '' },
      { name: 'Cautions', body: '' },
      { name: 'Context Pack', body: '' },
    ]);

    expect(meta.files_to_read_with_tools).toEqual([
      'src/core/context/markdown_flash_output_parser.ts',
      'src/core/context/flash_output_meta.ts',
    ]);
  });

  test('relevant_tests list can be extracted', () => {
    const meta = extractFlashOutputMeta([
      { name: 'Relevant Tests', body: '- tests/flash_output_parser.test.ts — unit coverage\n' },
      { name: 'Task Summary', body: '' },
      { name: 'Relevant Files', body: '' },
      { name: 'Files To Read With Tools', body: '' },
      { name: 'Commands To Run', body: '' },
      { name: 'Selected Skills', body: '' },
      { name: 'Cautions', body: '' },
      { name: 'Context Pack', body: '' },
    ]);

    expect(meta.relevant_tests).toEqual(['tests/flash_output_parser.test.ts']);
  });

  test('commands_to_run list can be extracted', () => {
    const meta = extractFlashOutputMeta([
      { name: 'Commands To Run', body: '- pnpm test — run the suite\n- pnpm vibecode flash validate tests/fixtures/flash_output_valid.md\n' },
      { name: 'Task Summary', body: '' },
      { name: 'Relevant Files', body: '' },
      { name: 'Files To Read With Tools', body: '' },
      { name: 'Relevant Tests', body: '' },
      { name: 'Selected Skills', body: '' },
      { name: 'Cautions', body: '' },
      { name: 'Context Pack', body: '' },
    ]);

    expect(meta.commands_to_run).toEqual([
      'pnpm test',
      'pnpm vibecode flash validate tests/fixtures/flash_output_valid.md',
    ]);
  });

  test('cautions list can be extracted', () => {
    const meta = extractFlashOutputMeta([
      { name: 'Cautions', body: '- keep parser strict\n* do not invent missing sections — validation guard\n' },
      { name: 'Task Summary', body: '' },
      { name: 'Relevant Files', body: '' },
      { name: 'Files To Read With Tools', body: '' },
      { name: 'Relevant Tests', body: '' },
      { name: 'Commands To Run', body: '' },
      { name: 'Selected Skills', body: '' },
      { name: 'Context Pack', body: '' },
    ]);

    expect(meta.cautions).toEqual(['keep parser strict', 'do not invent missing sections']);
    expect(meta.warnings).toEqual([]);
  });

  test('flash_output_meta.json writer writes stable metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-meta-'));
    const meta = {
      selected_skills: ['test-driven-development'],
      relevant_files: ['src/core/context/index.ts'],
      files_to_read_with_tools: ['src/core/context/markdown_flash_output_parser.ts'],
      relevant_tests: ['tests/flash_output_parser.test.ts'],
      commands_to_run: ['pnpm test'],
      cautions: ['keep strict'],
      warnings: [],
    };

    const filePath = writeFlashOutputMeta(tmpDir, meta);
    expect(filePath).toBe(path.join(tmpDir, 'flash_output_meta.json'));
    expect(fs.readFileSync(filePath, 'utf8')).toBe(`${JSON.stringify(meta, null, 2)}\n`);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(meta);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parser does not require flash_output.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-flash-json-'));
    const markdown = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'flash_output_valid.md'), 'utf8');
    expect(fs.existsSync(path.join(tmpDir, 'flash_output.json'))).toBe(false);

    const result = parseFlashOutput(markdown, path.join(tmpDir, 'flash_output.md'));
    expect(result.ok).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
