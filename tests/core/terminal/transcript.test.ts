import { OutputExcerpt } from '../../../src/core/terminal/transcript.js';

describe('OutputExcerpt', () => {
  test('stores appended data', () => {
    const excerpt = new OutputExcerpt();

    excerpt.append('hello');
    excerpt.append(' world');

    expect(excerpt.getText()).toBe('hello world');
  });

  test('bounds to last N lines', () => {
    const excerpt = new OutputExcerpt({ maxLines: 3 });

    excerpt.append('one\ntwo\nthree\nfour\nfive');

    expect(excerpt.getLines()).toEqual(['three', 'four', 'five']);
  });

  test('preserves latest output instead of oldest output', () => {
    const excerpt = new OutputExcerpt({ maxLines: 2 });

    excerpt.append('oldest\nmiddle\nlatest');

    expect(excerpt.getText()).toBe('middle\nlatest');
    expect(excerpt.getText()).not.toContain('oldest');
  });

  test('getText joins lines', () => {
    const excerpt = new OutputExcerpt({ maxLines: 5 });

    excerpt.append('alpha\nbeta');

    expect(excerpt.getText()).toBe('alpha\nbeta');
  });

  test('preserves Unicode', () => {
    const excerpt = new OutputExcerpt();

    excerpt.append('héllo wörld 🌍');

    expect(excerpt.getText()).toContain('héllo wörld 🌍');
  });

  test('clear resets state', () => {
    const excerpt = new OutputExcerpt();
    excerpt.append('some output');

    excerpt.clear();

    expect(excerpt.getLines()).toEqual([]);
    expect(excerpt.getText()).toBe('');
  });
});
