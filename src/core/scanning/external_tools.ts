import fs from 'fs';
import path from 'path';

import { CodeGraphDetection } from '../../adapters/codegraph/codegraph_types.js';
import type { CodeGraphContextResult } from '../../adapters/codegraph/codegraph_context.js';

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
  used_for_context?: boolean;
  context_artifact?: string;
  usage_artifact?: string;
  usage_reason?: string;
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

export function augmentExternalToolsWithCodeGraphContext(
  scanDir: string,
  contextResult: CodeGraphContextResult,
): string {
  const outPath = path.join(scanDir, EXTERNAL_TOOLS_FILENAME);
  let artifact: ExternalToolsArtifact = {
    tools: {
      codegraph: {
        available: false,
        initialized: false,
        mode: contextResult.mode,
        warnings: [],
      },
    },
  };
  try {
    if (fs.existsSync(outPath)) {
      artifact = JSON.parse(fs.readFileSync(outPath, 'utf8')) as ExternalToolsArtifact;
    }
  } catch {
    // Preserve stable output shape even if the prior detection artifact is corrupt.
  }

  const current = artifact.tools?.codegraph ?? {
    available: false,
    initialized: false,
    mode: contextResult.mode,
    warnings: [],
  };
  const codegraph: CodeGraphToolEntry = {
    ...current,
    mode: contextResult.mode,
    used_for_context: contextResult.used,
    usage_artifact: 'scan/codegraph_usage.json',
    usage_reason: contextResult.reason,
    warnings: Array.from(new Set([...(current.warnings ?? []), ...contextResult.warnings])),
  };
  if (contextResult.used) codegraph.context_artifact = 'scan/codegraph_context.md';
  artifact = { tools: { codegraph } };
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return outPath;
}
