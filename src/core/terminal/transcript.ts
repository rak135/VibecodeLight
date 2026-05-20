import { filterKnownPtyNoise, normalizeTerminalOutput } from './output_normalization.js';

export interface OutputExcerptOptions {
  maxLines?: number;
  maxChars?: number;
}

export class OutputExcerpt {
  private text = '';
  private readonly maxLines: number;
  private readonly maxChars?: number;

  constructor(options: OutputExcerptOptions = {}) {
    this.maxLines = options.maxLines ?? 500;
    this.maxChars = options.maxChars;
  }

  append(data: string): void {
    this.text += data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.trim();
  }

  getLines(): string[] {
    if (this.text.length === 0) {
      return [];
    }
    return this.text.split('\n');
  }

  getText(): string {
    return this.text;
  }

  /**
   * Returns a clean version of the excerpt suitable for JSON or human artifacts:
   * - ANSI escape sequences stripped
   * - Known PTY infrastructure noise filtered
   * - Unicode preserved
   */
  getCleanText(): string {
    return filterKnownPtyNoise(normalizeTerminalOutput(this.text));
  }

  clear(): void {
    this.text = '';
  }

  private trim(): void {
    if (this.maxChars !== undefined && this.text.length > this.maxChars) {
      this.text = this.text.slice(-this.maxChars);
    }

    if (this.maxLines >= 0) {
      const lines = this.text.split('\n');
      if (lines.length > this.maxLines) {
        this.text = lines.slice(-this.maxLines).join('\n');
      }
    }
  }
}
