import fs from 'fs';
import path from 'path';

import { CodeGraphDetection } from '../../adapters/codegraph/codegraph_types.js';

/**
 * TypeScript-owned scan artifact recording optional external-tool detection.
 *
 * This artifact records detection only. It must not include CodeGraph context
 * output, graph dumps, or source snippets. See docs/codegraph.md (Phase 1).
 */
export const EXTERNAL_TOOLS_FILENAME = 'external_tools.json';
export const EXTERNAL_TOOLS_MODE = 'detect-only';

export interface CodeGraphToolEntry {
  available: boolean;
  initialized: boolean;
  mode: string;
  warnings: string[];
  codegraph_dir?: string;
}

export interface ExternalToolsArtifact {
  tools: {
    codegraph: CodeGraphToolEntry;
  };
}

export function buildExternalToolsArtifact(detection: CodeGraphDetection): ExternalToolsArtifact {
  const codegraph: CodeGraphToolEntry = {
    available: detection.available,
    initialized: detection.initialized,
    mode: EXTERNAL_TOOLS_MODE,
    warnings: [...detection.warnings],
  };
  if (detection.initialized && detection.codegraphDir) {
    codegraph.codegraph_dir = detection.codegraphDir;
  }
  return { tools: { codegraph } };
}

export function writeExternalToolsArtifact(scanDir: string, detection: CodeGraphDetection): string {
  const artifact = buildExternalToolsArtifact(detection);
  const outPath = path.join(scanDir, EXTERNAL_TOOLS_FILENAME);
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return outPath;
}
