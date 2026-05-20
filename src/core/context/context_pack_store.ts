import fs from 'fs';
import path from 'path';

import { parseFlashOutput } from './markdown_flash_output_parser.js';

export function writeContextPack(runDir: string, flashOutputMd: string): string {
  const sourcePath = path.join(runDir, 'flash', 'flash_output.md');
  const parsed = parseFlashOutput(flashOutputMd, sourcePath);

  if (!parsed.ok) {
    const message = parsed.diagnostic?.message ?? 'flash output invalid';
    const error = new Error(message) as Error & { code?: string; path?: string; details?: string[] };
    error.code = parsed.diagnostic?.code ?? 'FLASH_OUTPUT_INVALID';
    error.path = parsed.diagnostic?.path ?? sourcePath;
    error.details = parsed.diagnostic?.details ?? [];
    throw error;
  }

  const contextPack = parsed.sections.find((section) => section.name === 'Context Pack');
  const outputDir = path.join(runDir, 'output');
  const outputPath = path.join(outputDir, 'context_pack.md');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, contextPack?.body ?? '', 'utf8');
  return outputPath;
}
