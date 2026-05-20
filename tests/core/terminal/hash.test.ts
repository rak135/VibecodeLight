import { sha256 } from '../../../src/core/terminal/hash.js';

describe('sha256', () => {
  test('returns a 64-character hex digest of a string', () => {
    const digest = sha256('hello world');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  test('different inputs produce different digests', () => {
    expect(sha256('hello')).not.toBe(sha256('hello\n'));
  });

  test('utf-8 content is hashed deterministically', () => {
    const text = '# Task\n\nšířka — ✅\n';
    expect(sha256(text)).toBe(sha256(text));
  });

  test('Buffer input is supported', () => {
    const buf = Buffer.from('hello world', 'utf8');
    expect(sha256(buf)).toBe(sha256('hello world'));
  });
});
