/**
 * Minimal `.env` loader (no dotenv dependency). Reads `.env.local` then
 * `.env` from the working directory; existing `process.env` values always
 * win, and `.env.local` wins over `.env`. Values are never logged.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const ENV_FILE_NAMES = ['.env.local', '.env'] as const;

/** Returns the names of the env files that were found and applied. */
export function loadDotEnv(cwd: string = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const name of ENV_FILE_NAMES) {
    let raw: string;
    try {
      raw = readFileSync(path.join(cwd, name), 'utf8');
    } catch {
      continue;
    }
    applyEnvFile(raw);
    loaded.push(name);
  }
  return loaded;
}

function applyEnvFile(raw: string): void {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // never override real env

    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
