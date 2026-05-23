import fs from 'fs';
import os from 'os';
import path from 'path';

import { readRunContextSummary } from '../../../src/core/context/run_context_summary.js';

describe('readRunContextSummary', () => {
  let runDir: string;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-ctx-summary-'));
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('reads relevant files, commands, and cautions from flash_output_meta.json', () => {
    const flashDir = path.join(runDir, 'flash');
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(
      path.join(flashDir, 'flash_output_meta.json'),
      JSON.stringify({
        relevant_files: ['README.md', 'src/index.ts'],
        files_to_read_with_tools: ['docs/ARCHITECTURE.md'],
        commands_to_run: ['pnpm test'],
        cautions: ['be careful'],
        selected_skills: ['tdd'],
      }),
      'utf8',
    );

    const summary = readRunContextSummary(runDir);
    expect(summary.relevant_files).toEqual(['README.md', 'src/index.ts']);
    expect(summary.files_to_read_with_tools).toEqual(['docs/ARCHITECTURE.md']);
    expect(summary.commands_to_run).toEqual(['pnpm test']);
    expect(summary.cautions).toEqual(['be careful']);
  });

  test('reads selected skills (id + title) from selected_skills.json', () => {
    const skillsDir = path.join(runDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'selected_skills.json'),
      JSON.stringify({
        run_id: 'r1',
        selected_skills: [
          { id: 'tdd', title: 'Test Driven Development', source: 'default', scope: 'global', path: '/x' },
        ],
        warnings: [],
        missing_skills: [],
      }),
      'utf8',
    );

    const summary = readRunContextSummary(runDir);
    expect(summary.selected_skills).toEqual([{ id: 'tdd', title: 'Test Driven Development' }]);
  });

  test('falls back to id when a selected skill has no title', () => {
    const skillsDir = path.join(runDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'selected_skills.json'),
      JSON.stringify({ selected_skills: [{ id: 'only-id' }] }),
      'utf8',
    );

    const summary = readRunContextSummary(runDir);
    expect(summary.selected_skills).toEqual([{ id: 'only-id', title: 'only-id' }]);
  });

  test('returns empty lists when artifacts are missing', () => {
    expect(readRunContextSummary(runDir)).toEqual({
      relevant_files: [],
      files_to_read_with_tools: [],
      commands_to_run: [],
      cautions: [],
      selected_skills: [],
    });
  });

  test('tolerates malformed JSON without throwing', () => {
    const flashDir = path.join(runDir, 'flash');
    fs.mkdirSync(flashDir, { recursive: true });
    fs.writeFileSync(path.join(flashDir, 'flash_output_meta.json'), '{ not json', 'utf8');

    expect(readRunContextSummary(runDir).relevant_files).toEqual([]);
  });
});
