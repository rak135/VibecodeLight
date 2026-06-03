import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test } from 'vitest';

import { runPromptPipeline } from '../../../src/core/prompting/pipeline.js';

function makeRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'fixture.ts'), 'export const fixture = true;\n', 'utf8');
  return repoRoot;
}

describe('prompt pipeline flash budget characterization', () => {
  test('successful full mock pipeline records provider_called true in flash budget', async () => {
    const repoRoot = makeRepo('vibecode-pipeline-flash-budget-');
    try {
      const result = await runPromptPipeline({
        task: 'flash budget provider-called characterization',
        repoRoot,
        mock: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const budgetPath = path.join(result.runDir, 'flash', 'flash_input_budget.json');
      expect(fs.existsSync(budgetPath)).toBe(true);
      expect(result.flashInputBudgetPath).toBe(budgetPath);

      const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8')) as { provider_called?: unknown };
      expect(budget.provider_called).toBe(true);
      expect(result.providerCalled).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
