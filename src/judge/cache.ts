/**
 * Disk cache for judge responses: one JSON file per sha256 key under
 * `~/.agent-evals/cache/`. Entries store the extracted JSON text of a
 * validated judge response, so re-running an eval over the same session with
 * the same model is free.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultJudgeCacheDir(): string {
  return join(homedir(), '.agent-evals', 'cache');
}

/** sha256 hex digest over the given parts (NUL-joined to avoid collisions). */
export function judgeCacheKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

interface CacheEntry {
  version: 1;
  createdAt: string;
  model: string;
  response: string;
}

export class DiskCache {
  constructor(private readonly dir: string = defaultJudgeCacheDir()) {}

  /** Returns the cached response text, or undefined on miss/corrupt entry. */
  async get(key: string): Promise<string | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf8');
      const entry = JSON.parse(raw) as Partial<CacheEntry>;
      return typeof entry.response === 'string' ? entry.response : undefined;
    } catch {
      return undefined;
    }
  }

  /** Best-effort write; a failed cache write never fails the evaluation. */
  async set(key: string, response: string, meta: { model: string }): Promise<void> {
    const entry: CacheEntry = {
      version: 1,
      createdAt: new Date().toISOString(),
      model: meta.model,
      response,
    };
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.pathFor(key), JSON.stringify(entry), 'utf8');
    } catch {
      // ignore
    }
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }
}
