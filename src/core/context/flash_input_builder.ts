import path from 'path';

import { readSavedArtifact } from './artifact_reader.js';
import {
  buildFlashInputManifest,
  FLASH_INPUT_OPTIONAL_INPUTS,
  FLASH_INPUT_REQUIRED_INPUTS,
  FlashInputManifest,
} from './flash_input_manifest.js';

// Note: getPreviousRunSummary is called by the CLI/orchestrator and passed as previousRunSummary string.
// The builder only formats what it receives.

export interface BuildFlashInputOptions {
  run_id: string;
  task: string;
  repo_root: string;
  runDir: string;
  previousRunSummary?: string | undefined;
  manifest?: FlashInputManifest;
}

type ArtifactKind = 'json' | 'text';

interface ArtifactEntry {
  relativePath: string;
  kind: ArtifactKind;
}

function formatArtifactContent(content: string, kind: ArtifactKind): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return 'not available';
  }

  if (kind === 'json') {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``;
    } catch {
      return `\`\`\`text\n${trimmed}\n\`\`\``;
    }
  }

  return `\`\`\`text\n${trimmed}\n\`\`\``;
}

function renderSingleArtifact(runDir: string, relativePath: string, kind: ArtifactKind): string {
  const content = readSavedArtifact(runDir, relativePath);
  if (content === null) {
    return 'not available';
  }
  return formatArtifactContent(content, kind);
}

function renderMultiArtifactSection(runDir: string, entries: ArtifactEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    const content = readSavedArtifact(runDir, entry.relativePath);
    if (content !== null) {
      parts.push(`### ${path.basename(entry.relativePath)}\n${formatArtifactContent(content, entry.kind)}`);
    }
  }
  if (parts.length === 0) {
    return 'not available';
  }
  return parts.join('\n\n');
}

function renderTaskSection(runDir: string): string {
  const task = readSavedArtifact(runDir, FLASH_INPUT_REQUIRED_INPUTS.user_prompt);
  if (task === null || !task.trim()) {
    return 'not available';
  }
  return `\`\`\`text\n${task.trim()}\n\`\`\``;
}

function renderRunMetadataSection(manifest: FlashInputManifest): string {
  return [
    `- run_id: ${manifest.run_id}`,
    `- created_at: ${manifest.created_at}`,
    `- repo_root: ${manifest.repo_root}`,
    `- task: ${manifest.task}`,
  ].join('\n');
}

export function buildFlashInput(opts: BuildFlashInputOptions): string {
  const manifest =
    opts.manifest ??
    buildFlashInputManifest({
      run_id: opts.run_id,
      task: opts.task,
      repo_root: opts.repo_root,
      runDir: opts.runDir,
    });

  const sections: Array<{ title: string; body: string }> = [
    { title: 'Task', body: renderTaskSection(opts.runDir) },
    { title: 'Run Metadata', body: renderRunMetadataSection(manifest) },
    {
      title: 'Git State',
      body: renderMultiArtifactSection(opts.runDir, [
        { relativePath: FLASH_INPUT_OPTIONAL_INPUTS.git_status, kind: 'json' },
        { relativePath: FLASH_INPUT_OPTIONAL_INPUTS.git_diff_stat, kind: 'text' },
      ]),
    },
    {
      title: 'Repository Tree',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.repo_tree, 'text'),
    },
    {
      title: 'File Inventory Summary',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.file_inventory, 'json'),
    },
    {
      title: 'Manifests and Dependencies',
      body: renderMultiArtifactSection(opts.runDir, [
        { relativePath: FLASH_INPUT_REQUIRED_INPUTS.scanner_config, kind: 'json' },
        { relativePath: FLASH_INPUT_REQUIRED_INPUTS.scan_manifest, kind: 'json' },
        { relativePath: FLASH_INPUT_OPTIONAL_INPUTS.manifests, kind: 'json' },
      ]),
    },
    {
      title: 'Environment',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.environment, 'json'),
    },
    {
      title: 'Commands',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.commands, 'json'),
    },
    {
      title: 'Tooling',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.tooling, 'json'),
    },
    {
      title: 'Repository Instructions',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.repo_instructions, 'json'),
    },
    {
      title: 'Documentation',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.docs, 'json'),
    },
    {
      title: 'Architecture Documents',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.architecture_docs, 'json'),
    },
    {
      title: 'Symbols',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.symbols, 'json'),
    },
    {
      title: 'Imports',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.imports, 'json'),
    },
    {
      title: 'Entrypoints',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.entrypoints, 'json'),
    },
    {
      title: 'Tests',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.tests, 'json'),
    },
    {
      title: 'Schemas',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.schemas, 'json'),
    },
    {
      title: 'Keyword Hits',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.keyword_hits, 'json'),
    },
    {
      title: 'Recent History',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_OPTIONAL_INPUTS.recent_history, 'json'),
    },
    {
      title: 'Skills Catalog',
      body: renderSingleArtifact(opts.runDir, FLASH_INPUT_REQUIRED_INPUTS.skills_catalog, 'json'),
    },
    {
      title: 'Previous Run Summary',
      body: opts.previousRunSummary ?? 'none available',
    },
    {
      title: 'Flash Instructions',
      body: [
        'This file is the exact flash input material assembled from saved run artifacts.',
        'Use it as the source material for the flash model.',
        'Do not rescan the repository here and do not invent missing facts.',
        'Select the most relevant context for the task described above.',
      ].join('\n'),
    },
  ];

  const renderedSections = sections
    .map((section) => `# ${section.title}\n${section.body}`)
    .join('\n\n');

  return `${renderedSections}\n`;
}
