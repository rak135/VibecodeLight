import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvContent, loadEnvFile } from '../../../src/core/config/env_file.js';

describe('.env parsing', () => {
  test('ignores empty lines and comments', () => {
    const parsed = parseEnvContent(['', '# a comment', '   ', '# another', 'KEY=value', ''].join('\n'));
    expect(parsed).toEqual({ KEY: 'value' });
  });

  test('supports KEY=value', () => {
    expect(parseEnvContent('VIBECODE_FLASH_PROVIDER=openrouter')).toEqual({
      VIBECODE_FLASH_PROVIDER: 'openrouter',
    });
  });

  test('strips surrounding double and single quotes', () => {
    const parsed = parseEnvContent(['A="quoted value"', "B='single quoted'", 'C=bare'].join('\n'));
    expect(parsed).toEqual({ A: 'quoted value', B: 'single quoted', C: 'bare' });
  });

  test('strips an optional leading export', () => {
    expect(parseEnvContent('export VIBECODE_API_KEY=sk-test')).toEqual({ VIBECODE_API_KEY: 'sk-test' });
  });

  test('keeps = characters inside values', () => {
    expect(parseEnvContent('TOKEN=ab=cd=ef')).toEqual({ TOKEN: 'ab=cd=ef' });
  });

  test('loadEnvFile returns empty map when file is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-env-'));
    try {
      expect(loadEnvFile(path.join(dir, '.env'))).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadEnvFile reads a real file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibecode-env-'));
    try {
      const envPath = path.join(dir, '.env');
      fs.writeFileSync(envPath, 'VIBECODE_FLASH_API_KEY=sk-secret-value\n', 'utf8');
      expect(loadEnvFile(envPath)).toEqual({ VIBECODE_FLASH_API_KEY: 'sk-secret-value' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
