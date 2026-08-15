/**
 * Contract for session sources (Cursor, Claude Code, pi, ...). Phase 2
 * implements `CursorSource` in `src/adapters/cursor.ts` against this
 * interface; the CLI and metrics only ever see these types.
 */

import type { Session } from '../model/session.js';

/** Lightweight listing metadata, cheap to produce without parsing full transcripts. */
export interface SessionMeta {
  /** Source-scoped session id (for Cursor: the transcript UUID). */
  id: string;
  /** Which agent produced the session, e.g. "cursor". */
  agent: string;
  /** Project name or slug the session belongs to. */
  project: string;
  title: string;
  updatedAt: Date;
  /** Absolute path to the transcript file backing this session. */
  transcriptPath: string;
  /** Present only when cheap to compute during listing. */
  turnCount?: number;
}

export interface ListSessionsOptions {
  /** Maximum number of sessions to return. */
  limit?: number;
  /** Restrict to a single project (matches `SessionMeta.project`). */
  project?: string;
}

export interface SessionSource {
  /** Stable source identifier, e.g. "cursor". */
  readonly id: string;
  /** Human-readable name for pickers, e.g. "Cursor". */
  readonly name: string;

  /** True when the source's local session store exists on this machine. */
  isAvailable(): boolean;

  /** List available sessions, most recently updated first. */
  listSessions(options?: ListSessionsOptions): Promise<SessionMeta[]>;

  /**
   * Load and normalize a full session. Accepts a session id, a transcript
   * path, or a `SessionMeta` previously returned by `listSessions`.
   */
  loadSession(ref: string | SessionMeta): Promise<Session>;
}
