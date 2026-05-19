import { REQUIRED_SECTIONS, type FlashOutputDiagnostic, type FlashOutputParseResult, type FlashOutputSection } from './flash_output_contract.js';

function isTopLevelHeading(line: string): string | null {
  const match = line.match(/^#\s+(.+?)\s*$/);
  return match ? match[1] : null;
}

function buildDiagnostic(sourcePath: string, missingSections: string[]): FlashOutputDiagnostic {
  return {
    code: 'FLASH_OUTPUT_INVALID',
    message: `missing required sections: ${missingSections.join(', ')}`,
    path: sourcePath,
    details: [...missingSections],
  };
}

export function parseFlashOutput(markdown: string, sourcePath = '<input>'): FlashOutputParseResult {
  const lines = markdown.split(/\r?\n/);
  const sections: FlashOutputSection[] = [];

  let currentSectionName: string | null = null;
  let currentBodyLines: string[] = [];

  const flushCurrentSection = (): void => {
    if (currentSectionName === null) {
      return;
    }
    sections.push({
      name: currentSectionName,
      body: currentBodyLines.join('\n'),
    });
  };

  for (const line of lines) {
    const heading = isTopLevelHeading(line);
    if (heading !== null) {
      flushCurrentSection();
      currentSectionName = heading;
      currentBodyLines = [];
      continue;
    }

    if (currentSectionName !== null) {
      currentBodyLines.push(line);
    }
  }

  flushCurrentSection();

  const presentSections = new Set(sections.map((section) => section.name));
  const missingSections = REQUIRED_SECTIONS.filter((section) => !presentSections.has(section));

  if (missingSections.length > 0) {
    return {
      ok: false,
      rawMarkdown: markdown,
      sections,
      diagnostic: buildDiagnostic(sourcePath, missingSections),
    };
  }

  return {
    ok: true,
    rawMarkdown: markdown,
    sections,
  };
}
