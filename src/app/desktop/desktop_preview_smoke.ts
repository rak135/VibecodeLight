import fs from 'fs';
import path from 'path';

import { generatePromptPreview } from './prompt_preview_service.js';
import { resolveDesktopRepo } from './repo_resolver.js';

export async function runSmoke(repoRoot: string): Promise<void> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const result = await generatePromptPreview({
    task: 'desktop preview smoke',
    repoRoot: resolvedRepoRoot,
  });

  if (result.ok === false) {
    const error = result.error;
    const details = error.details.length > 0 ? `\n${error.details.join('\n')}` : '';
    throw new Error(`desktop preview smoke failed: ${error.code}: ${error.message}${details}`);
  }

  if (!fs.existsSync(result.finalPromptPath)) {
    throw new Error(`final_prompt.md missing: ${result.finalPromptPath}`);
  }

  const onDiskFinalPrompt = fs.readFileSync(result.finalPromptPath, 'utf8');
  if (result.finalPrompt !== onDiskFinalPrompt) {
    throw new Error(`final prompt mismatch for ${result.finalPromptPath}`);
  }

  const sendMetadataPath = path.join(result.runDir, 'terminal', 'send_metadata.json');
  if (fs.existsSync(sendMetadataPath)) {
    throw new Error(`unexpected send metadata created: ${sendMetadataPath}`);
  }

  const currentSendMetadataPath = path.join(resolvedRepoRoot, '.vibecode', 'current', 'send_metadata.json');
  if (fs.existsSync(currentSendMetadataPath)) {
    throw new Error(`unexpected current send metadata created: ${currentSendMetadataPath}`);
  }

  const afterDir = path.join(result.runDir, 'after');
  if (fs.existsSync(afterDir)) {
    throw new Error(`unexpected after/ directory created: ${afterDir}`);
  }
}

async function main(): Promise<void> {
  const repoArg = (() => {
    const argv = process.argv.slice(2);
    const idx = argv.indexOf('--repo');
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  })();

  const resolution = resolveDesktopRepo({ repoArg, cwd: process.cwd() });
  if (!resolution.ok) {
    console.error(`DESKTOP_PREVIEW_SMOKE_FAILED: ${resolution.error.code}: ${resolution.error.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    await runSmoke(resolution.repoRoot);
    console.log('DESKTOP_PREVIEW_SMOKE_OK');
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
