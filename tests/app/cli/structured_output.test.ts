import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  makeCliStructuredError,
  emitCliStructuredError,
} from '../../../src/app/cli/structured_output.js';

/**
 * Unit tests for the canonical CLI structured-error helper. These pin the
 * current envelope shape so the (presentation-only) CLI error format cannot
 * drift when command files route through the shared helper.
 */
describe('CLI structured error helper', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  test('makeCliStructuredError defaults path to "" and details to [] (current behavior, fields not omitted)', () => {
    const error = makeCliStructuredError('SOME_CODE', 'something went wrong');
    expect(error).toEqual({ code: 'SOME_CODE', message: 'something went wrong', path: '', details: [] });
    // No MCP-specific fields leak into the CLI error shape.
    expect(Object.keys(error).sort()).toEqual(['code', 'details', 'message', 'path']);
  });

  test('makeCliStructuredError preserves explicit path and details', () => {
    const error = makeCliStructuredError('CODE', 'msg', 'some/path', ['d1', 'd2']);
    expect(error).toEqual({ code: 'CODE', message: 'msg', path: 'some/path', details: ['d1', 'd2'] });
  });

  test('emitCliStructuredError --json prints exactly { ok:false, error } and sets exit code 1', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = 0;

    const error = makeCliStructuredError('CODE', 'boom', 'p', ['detail']);
    emitCliStructuredError(error, { json: true, prefix: 'thing failed' });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(payload).toEqual({ ok: false, error: { code: 'CODE', message: 'boom', path: 'p', details: ['detail'] } });
    // The envelope has only the two canonical top-level keys.
    expect(Object.keys(payload).sort()).toEqual(['error', 'ok']);
    expect(Number(process.exitCode)).toBe(1);
  });

  test('emitCliStructuredError non-json prints prefixed message, path, and detail lines to stderr', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = 0;

    const error = makeCliStructuredError('CODE', 'boom', 'some/path', ['d1', 'd2']);
    emitCliStructuredError(error, { json: false, prefix: 'thing failed' });

    expect(logSpy).not.toHaveBeenCalled();
    const lines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(['thing failed: boom', 'path: some/path', 'detail: d1', 'detail: d2']);
    expect(Number(process.exitCode)).toBe(1);
  });

  test('emitCliStructuredError non-json omits the path line when path is empty', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = 0;

    emitCliStructuredError(makeCliStructuredError('CODE', 'boom'), { json: false, prefix: 'thing failed' });

    const lines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual(['thing failed: boom']);
  });
});
