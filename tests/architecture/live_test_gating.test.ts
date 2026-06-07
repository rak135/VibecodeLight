import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

/**
 * Enforces the live-test gating policy from AGENTS.md:
 *
 * - live_*.test.ts files are allowed only for real live/integration tests.
 * - Every live_* must contain an explicit environment gate.
 * - Fake/mock provider tests must be named fake_* or mock_*, not live_*.
 * - A live_* file must not use fakeLiveFetch/mock provider as its main
 *   provider path.
 */

const TESTS_ROOT = path.resolve(__dirname, '..');

function collectTestFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('live test gating policy', () => {
  test('every live_*.test.ts file contains an explicit environment gate and does not use fake/mock providers', () => {
    const allTestFiles = collectTestFiles(TESTS_ROOT);
    const guardFile = path.resolve(__filename);
    const liveFiles = allTestFiles.filter((f) => {
      const base = path.basename(f);
      return base.startsWith('live_') && path.resolve(f) !== guardFile;
    });

    for (const liveFile of liveFiles) {
      const content = fs.readFileSync(liveFile, 'utf8');
      const relPath = path.relative(TESTS_ROOT, liveFile).replace(/\\/g, '/');

      // Must not use fakeLiveFetch as the main provider path
      expect(
        content,
        `${relPath}: live_* test must not use fakeLiveFetch — rename to fake_* or mock_*`,
      ).not.toMatch(/fakeLiveFetch/);

      // Must not construct mock/fake adapters as the primary provider
      expect(
        content,
        `${relPath}: live_* test must not construct mock/fake adapters — rename to fake_* or mock_*`,
      ).not.toMatch(/new OpenAiCompatibleAdapter\([^)]*fakeLiveFetch/);

      // Must contain an explicit environment gate
      // Accepted patterns: process.env.VIBECODE_*, ptyIntegrationEnabled, isLiveTestEnabled, etc.
      const hasEnvGate =
        content.includes('ptyIntegrationEnabled') ||
        content.includes('isPtyIntegrationEnabled') ||
        content.includes('isLiveTestEnabled') ||
        /process\.env\[?[\'"]VIBECODE_/.test(content) ||
        /process\.env\.VIBECODE_/.test(content) ||
        /env\[.*VIBECODE/.test(content);

      expect(
        hasEnvGate,
        `${relPath}: live_* test must contain an explicit environment gate (e.g. process.env.VIBECODE_* or ptyIntegrationEnabled)`,
      ).toBe(true);
    }
  });

  test('no fake_*.test.ts or mock_*.test.ts file contains a real provider call without a mock', () => {
    const allTestFiles = collectTestFiles(TESTS_ROOT);
    const fakeFiles = allTestFiles.filter((f) => {
      const base = path.basename(f);
      return base.startsWith('fake_') || base.startsWith('mock_');
    });

    for (const fakeFile of fakeFiles) {
      const content = fs.readFileSync(fakeFile, 'utf8');
      const relPath = path.relative(TESTS_ROOT, fakeFile).replace(/\\/g, '/');

      // A fake/mock test must not use real fetch without interception
      // (It should use fakeLiveFetch, vi.fn(), or mock adapters)
      if (content.includes('new OpenAiCompatibleAdapter(')) {
        expect(
          content,
          `${relPath}: fake/mock test using OpenAiCompatibleAdapter must inject a fake fetch`,
        ).toMatch(/fakeLiveFetch|vi\.fn|mock.*fetch|as typeof fetch/);
      }
    }
  });
});
