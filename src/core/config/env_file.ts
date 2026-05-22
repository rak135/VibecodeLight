import fs from 'fs';

/**
 * Parse the contents of a .env file into a key/value map.
 *
 * Rules:
 * - empty lines are ignored
 * - lines starting with '#' (comments) are ignored
 * - KEY=value pairs are supported
 * - an optional leading `export ` is stripped
 * - surrounding single or double quotes around the value are stripped
 *
 * This function never logs or prints values. Callers must treat returned values
 * as potentially secret and never write them to artifacts, diagnostics, or logs.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) {
      key = key.slice('export '.length).trim();
    }
    if (key.length === 0) continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value;
  }
  return result;
}

/** Load and parse a .env file. Returns an empty map if the file is absent or unreadable. */
export function loadEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) {
    return {};
  }
  try {
    return parseEnvContent(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}
