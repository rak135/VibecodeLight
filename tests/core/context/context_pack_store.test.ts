import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeContextPack } from '../../../src/core/context/context_pack_store';

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-context-pack-store-'));
}

function validFlashOutput(contextPackBody = 'Line one\n\nLine two\n'): string {
  return [
    '# Task Summary',
    'Task summary body.',
    '',
    '# Relevant Files',
    '- README.md',
    '',
    '# Files To Read With Tools',
    '- README.md',
    '',
    '# Relevant Tests',
    '- pnpm test',
    '',
    '# Commands To Run',
    '- pnpm test',
    '',
    '# Selected Skills',
    '- tdd',
    '',
    '# Cautions',
    '- Be careful.',
    '',
    '# Context Pack',
    contextPackBody,
  ].join('\n');
}

describe('writeContextPack', () => {
  test('valid flash_output.md writes output/context_pack.md', () => {
    const runDir = tmpRunDir();

    const written = writeContextPack(runDir, validFlashOutput('Context body.\n'));

    expect(fs.existsSync(written)).toBe(true);
    expect(path.basename(written)).toBe('context_pack.md');
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('context_pack.md content equals the # Context Pack section body', () => {
    const runDir = tmpRunDir();
    const body = 'Keep this exact context.\n\n- Including bullets.\n';

    const written = writeContextPack(runDir, validFlashOutput(body));

    expect(fs.readFileSync(written, 'utf8')).toBe(body);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('invalid flash_output.md throws before writing context_pack.md', () => {
    const runDir = tmpRunDir();
    const invalid = ['# Task Summary', 'Missing most required sections.', ''].join('\n');

    expect(() => writeContextPack(runDir, invalid)).toThrow(/missing required sections/i);
    expect(fs.existsSync(path.join(runDir, 'output', 'context_pack.md'))).toBe(false);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  test('context_pack.md file is created in correct path', () => {
    const runDir = tmpRunDir();

    const written = writeContextPack(runDir, validFlashOutput('Correct path body.\n'));

    expect(written).toBe(path.join(runDir, 'output', 'context_pack.md'));
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
