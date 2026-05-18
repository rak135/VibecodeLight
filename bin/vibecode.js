#!/usr/bin/env node
// VibecodeLight local dev CLI entry point.
// Uses tsx CJS hook to load TypeScript source directly without pre-compilation.
require('tsx/cjs');
const { runCli } = require('../src/app/cli/index.ts');
void runCli().catch((/** @type {unknown} */ error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
