import fs from 'fs';
import path from 'path';

import type { FlashOutputSection } from './flash_output_contract.js';

export interface FlashOutputMeta {
  task_summary?: string;
  selected_skills: string[];
  relevant_files: string[];
  files_to_read_with_tools: string[];
  relevant_tests: string[];
  commands_to_run: string[];
  cautions: string[];
  warnings: string[];
}

function extractListItems(body: string): string[] {
  if (!body.trim()) {
    return [];
  }

  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => {
      const item = line.slice(2).trim();
      const [firstToken] = item.split(' — ');
      return firstToken.trim();
    })
    .filter((item) => item.length > 0);
}

function getSectionBody(sections: FlashOutputSection[], name: string): string {
  return sections.find((section) => section.name === name)?.body ?? '';
}

export function extractFlashOutputMeta(sections: FlashOutputSection[]): FlashOutputMeta {
  return {
    task_summary: getSectionBody(sections, 'Task Summary').trim() || undefined,
    selected_skills: extractListItems(getSectionBody(sections, 'Selected Skills')),
    relevant_files: extractListItems(getSectionBody(sections, 'Relevant Files')),
    files_to_read_with_tools: extractListItems(getSectionBody(sections, 'Files To Read With Tools')),
    relevant_tests: extractListItems(getSectionBody(sections, 'Relevant Tests')),
    commands_to_run: extractListItems(getSectionBody(sections, 'Commands To Run')),
    cautions: extractListItems(getSectionBody(sections, 'Cautions')),
    warnings: [],
  };
}

export function writeFlashOutputMeta(flashDir: string, meta: FlashOutputMeta): string {
  fs.mkdirSync(flashDir, { recursive: true });
  const filePath = path.join(flashDir, 'flash_output_meta.json');
  fs.writeFileSync(filePath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return filePath;
}

export interface FlashRunMeta {
  provider: string | null;
  provider_label: string | null;
  model: string | null;
  model_label: string | null;
  live: boolean;
  baseUrl_host: string | null;
  config_source: string | null;
  config_resolution_path: string | null;
}

/**
 * Merge run-level provenance (provider/model/live/baseUrl_host/config source)
 * into an existing flash_output_meta.json. Never includes secrets. Called by the
 * orchestration layer after the adapter writes the base metadata so that the
 * adapter-owned contract stays unchanged.
 */
export function enrichFlashOutputMeta(flashDir: string, runMeta: FlashRunMeta): string {
  const filePath = path.join(flashDir, 'flash_output_meta.json');
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...runMeta };
  fs.mkdirSync(flashDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return filePath;
}
