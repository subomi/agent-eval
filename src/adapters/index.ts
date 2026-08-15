/**
 * Session-source registry: every source keyed by id, plus the availability
 * helper the CLI uses to resolve `--agents all` (a source is available when
 * its local session store exists on this machine).
 */

import { cursorSource } from './cursor.js';
import { claudeCodeSource, codexSource } from './trajectory.js';
import type { SessionSource } from './types.js';

export type { ListSessionsOptions, SessionMeta, SessionSource } from './types.js';
export { CursorSource, cursorSource } from './cursor.js';
export type { CursorSessionMeta, CursorSourceOptions } from './cursor.js';
export { claudeCodeSource, codexSource, TrajectorySource } from './trajectory.js';

/** All known sources, in canonical display order. */
export const allSources: readonly SessionSource[] = [cursorSource, claudeCodeSource, codexSource];

/** All known source ids, e.g. for validation error messages. */
export const allSourceIds: readonly string[] = allSources.map((s) => s.id);

export function sourceById(id: string): SessionSource | undefined {
  return allSources.find((s) => s.id === id);
}

/** Sources whose local session store exists on this machine. */
export function availableSources(): SessionSource[] {
  return allSources.filter((s) => s.isAvailable());
}
