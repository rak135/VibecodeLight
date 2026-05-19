export const REQUIRED_SECTIONS = [
  'Task Summary',
  'Relevant Files',
  'Files To Read With Tools',
  'Relevant Tests',
  'Commands To Run',
  'Selected Skills',
  'Cautions',
  'Context Pack',
] as const;

export type FlashOutputSectionName = typeof REQUIRED_SECTIONS[number];

export interface FlashOutputSection {
  name: string;
  body: string;
}

export interface FlashOutputDiagnostic {
  code: 'FLASH_OUTPUT_INVALID';
  message: string;
  path: string;
  details: string[];
}

export interface FlashOutputParseResult {
  ok: boolean;
  rawMarkdown: string;
  sections: FlashOutputSection[];
  diagnostic?: FlashOutputDiagnostic;
}
