/**
 * Cursor `SessionSource`: discovers agent transcripts under
 * `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`, joins
 * titles/recency from Cursor's conversation-search SQLite db (read-only,
 * with graceful fallback to file mtime + first-user-query snippet when the
 * db is locked or missing), and parses the Anthropic-style JSONL into the
 * normalized `Session` model.
 *
 * Real-transcript quirks handled here (verified against local data):
 * - Lines like `{"type":"turn_ended","status":"success"|"error"|"aborted"}`
 *   are turn-boundary markers, not messages — skipped.
 * - User text is wrapped in system-added tags. The real query lives in
 *   `<user_query>...</user_query>`; surrounding blocks (`<timestamp>`,
 *   `<system_reminder>`, `<mcp_server_catalog>`, ...) are stripped.
 *   Attachment blocks (`<attached_files>`, `<code_selection>`, ...) are
 *   noted with a short `[user attached: ...]` marker since they signal
 *   context the user provided. User messages with no `<user_query>` at all
 *   (e.g. "Your previous response was interrupted...") are system-generated
 *   and kept distinguishable via a `[system]` / `[system context: ...]`
 *   marker.
 * - The same session uuid can exist under multiple project folders (window
 *   moved between roots); duplicates are collapsed keeping the freshest file.
 * - Cursor transcripts record only `text` and `tool_use` content — there are
 *   no tool results, so `ToolCall.result`/`isError` stay unset.
 * - Malformed lines are skipped; "[REDACTED]" placeholders pass through.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Session, ToolCall, Turn } from '../model/session.js';
import type { ListSessionsOptions, SessionMeta, SessionSource } from './types.js';

const TITLE_SNIPPET_MAX_CHARS = 64;

/** `SessionMeta` plus the raw Cursor project folder slug. */
export interface CursorSessionMeta extends SessionMeta {
  projectSlug: string;
}

export interface CursorSourceOptions {
  /** Override for `~/.cursor/projects` (mainly for tests). */
  projectsDir?: string;
  /** Override for the conversation-search.db path (mainly for tests). */
  searchDbPath?: string;
}

interface TranscriptFile {
  id: string;
  projectSlug: string;
  path: string;
  mtimeMs: number;
  size: number;
}

interface TitleRow {
  title: string;
  updatedAtMs: number;
}

export class CursorSource implements SessionSource {
  readonly id = 'cursor';
  readonly name = 'Cursor';

  private readonly projectsDir: string;
  private readonly searchDbPath: string;

  constructor(options: CursorSourceOptions = {}) {
    this.projectsDir = options.projectsDir ?? path.join(homedir(), '.cursor', 'projects');
    this.searchDbPath =
      options.searchDbPath ??
      path.join(
        homedir(),
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'conversation-search.db',
      );
  }

  isAvailable(): boolean {
    return existsSync(this.projectsDir);
  }

  /**
   * List sessions, most recently updated first. Without `options.limit`
   * every discovered session is returned (batch needs the full corpus).
   */
  async listSessions(options: ListSessionsOptions = {}): Promise<CursorSessionMeta[]> {
    const transcripts = await this.discoverTranscripts();
    const titles = this.readTitleIndex();

    let metas: CursorSessionMeta[] = transcripts.map((t) => {
      const row = titles.get(t.id);
      return {
        id: t.id,
        agent: this.id,
        project: friendlyProjectLabel(t.projectSlug),
        projectSlug: t.projectSlug,
        title: row?.title ?? '',
        updatedAt: new Date(row?.updatedAtMs ?? t.mtimeMs),
        transcriptPath: t.path,
      };
    });

    if (options.project !== undefined) {
      const wanted = options.project.toLowerCase();
      metas = metas.filter(
        (m) => m.project.toLowerCase() === wanted || m.projectSlug.toLowerCase() === wanted,
      );
    }

    metas.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (options.limit !== undefined) metas = metas.slice(0, options.limit);

    // Fallback titles (db locked/missing, or subagent transcripts that are
    // not indexed): derive a snippet from the first real user query. Only
    // done for the sessions that survived the limit cut, to keep listing fast.
    await Promise.all(
      metas
        .filter((m) => m.title.length === 0)
        .map(async (m) => {
          m.title = (await firstUserQuerySnippet(m.transcriptPath)) ?? 'Untitled session';
        }),
    );

    return metas;
  }

  async loadSession(ref: string | SessionMeta): Promise<Session> {
    const located = await this.resolveRef(ref);
    const rawBytes = await readFile(located.transcriptPath);
    const contentHash = createHash('sha256').update(rawBytes).digest('hex');
    const raw = rawBytes.toString('utf8');
    const turns = parseTranscriptLines(raw);

    let title = located.title;
    let updatedAt = located.updatedAt;
    if (title === undefined || updatedAt === undefined) {
      const row = this.readTitleIndex().get(located.id);
      title ??= row?.title;
      updatedAt ??= row ? new Date(row.updatedAtMs) : undefined;
    }
    if (title === undefined) {
      const firstUser = turns.find((t) => t.role === 'user' && !t.text.startsWith('[system'));
      title = firstUser ? snippetOf(firstUser.text) : 'Untitled session';
    }
    if (updatedAt === undefined) {
      updatedAt = new Date((await stat(located.transcriptPath)).mtimeMs);
    }

    return {
      id: located.id,
      agent: this.id,
      project: located.project ?? 'unknown',
      title,
      updatedAt,
      contentHash,
      transcriptPath: located.transcriptPath,
      turns,
    };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Scan every `<projectsDir>/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`,
   * skipping empty transcript folders and collapsing duplicate session ids
   * (a session moved between windows leaves stale copies behind — keep the
   * most recently modified file, tie-broken by size).
   */
  private async discoverTranscripts(): Promise<TranscriptFile[]> {
    const byId = new Map<string, TranscriptFile>();

    let projectDirs;
    try {
      projectDirs = await readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const projectEntry of projectDirs) {
      if (!projectEntry.isDirectory()) continue;
      const slug = projectEntry.name;
      const transcriptsDir = path.join(this.projectsDir, slug, 'agent-transcripts');

      let sessionDirs;
      try {
        sessionDirs = await readdir(transcriptsDir, { withFileTypes: true });
      } catch {
        continue; // no agent-transcripts folder for this project
      }

      for (const sessionEntry of sessionDirs) {
        if (!sessionEntry.isDirectory()) continue;
        const sessionDir = path.join(transcriptsDir, sessionEntry.name);
        const transcriptPath = await findTranscriptFile(sessionDir, sessionEntry.name);
        if (transcriptPath === undefined) continue; // empty session folder

        let fileStat;
        try {
          fileStat = await stat(transcriptPath);
        } catch {
          continue;
        }

        const candidate: TranscriptFile = {
          id: path.basename(transcriptPath, '.jsonl'),
          projectSlug: slug,
          path: transcriptPath,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
        };
        const existing = byId.get(candidate.id);
        if (
          existing === undefined ||
          candidate.mtimeMs > existing.mtimeMs ||
          (candidate.mtimeMs === existing.mtimeMs && candidate.size > existing.size)
        ) {
          byId.set(candidate.id, candidate);
        }
      }
    }

    return [...byId.values()];
  }

  private async resolveRef(
    ref: string | SessionMeta,
  ): Promise<{ id: string; transcriptPath: string; project?: string; title?: string; updatedAt?: Date }> {
    if (typeof ref !== 'string') {
      return {
        id: ref.id,
        transcriptPath: ref.transcriptPath,
        project: ref.project,
        title: ref.title,
        updatedAt: ref.updatedAt,
      };
    }

    // A transcript path (absolute or relative).
    if (ref.endsWith('.jsonl') || ref.includes(path.sep)) {
      if (!existsSync(ref)) {
        throw new Error(`Cursor transcript not found at path: ${ref}`);
      }
      const resolved = path.resolve(ref);
      const slug = projectSlugFromTranscriptPath(resolved, this.projectsDir);
      const out: { id: string; transcriptPath: string; project?: string } = {
        id: path.basename(resolved, '.jsonl'),
        transcriptPath: resolved,
      };
      if (slug !== undefined) out.project = friendlyProjectLabel(slug);
      return out;
    }

    // A session uuid: locate it among discovered transcripts.
    const match = (await this.discoverTranscripts()).find((t) => t.id === ref);
    if (match === undefined) {
      throw new Error(`No Cursor transcript found for session id "${ref}" under ${this.projectsDir}`);
    }
    return {
      id: match.id,
      transcriptPath: match.path,
      project: friendlyProjectLabel(match.projectSlug),
    };
  }

  // -------------------------------------------------------------------------
  // Title/recency index from conversation-search.db
  // -------------------------------------------------------------------------

  /**
   * Read `{id -> {title, updated_at}}` from Cursor's search db. Opened
   * read-only; any failure (missing file, lock held by a running Cursor,
   * schema drift) yields an empty map so listing falls back to file mtime
   * and first-user-query snippets instead of crashing.
   */
  private readTitleIndex(): Map<string, TitleRow> {
    const index = new Map<string, TitleRow>();
    if (!existsSync(this.searchDbPath)) return index;

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.searchDbPath, { readOnly: true });
      const rows = db
        .prepare("SELECT id, title, updated_at FROM conversations WHERE source = 'local'")
        .all();
      for (const row of rows) {
        const { id, title, updated_at: updatedAt } = row as Record<string, unknown>;
        if (typeof id === 'string' && typeof title === 'string' && typeof updatedAt === 'number') {
          index.set(id, { title, updatedAtMs: updatedAt });
        }
      }
    } catch {
      index.clear(); // partial reads are worse than a consistent fallback
    } finally {
      try {
        db?.close();
      } catch {
        // already closed or never opened
      }
    }
    return index;
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface RawContentItem {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

/** Parse a full transcript into normalized turns (exported for testing). */
export function parseTranscriptLines(raw: string): Turn[] {
  const turns: Turn[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // malformed line
    }
    if (parsed === null || typeof parsed !== 'object') continue;

    const record = parsed as { role?: unknown; message?: unknown };
    const role = record.role;
    if (role !== 'user' && role !== 'assistant') continue; // e.g. turn_ended markers

    const message = record.message;
    if (message === null || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    if (typeof content === 'string') {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content as RawContentItem[]) {
        if (item === null || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string') {
          textParts.push(item.text);
        } else if (item.type === 'tool_use' && typeof item.name === 'string') {
          toolCalls.push({ name: item.name, input: item.input });
        }
        // Unknown content types are ignored (forward compatibility).
      }
    } else {
      continue;
    }

    const joined = textParts.join('\n\n');
    const text = role === 'user' ? cleanUserText(joined) : joined.trim();
    if (text.length === 0 && toolCalls.length === 0) continue;

    turns.push({ index: turns.length + 1, role, text, toolCalls });
  }

  return turns;
}

// ---------------------------------------------------------------------------
// User-text extraction
// ---------------------------------------------------------------------------

const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/g;

/** Blocks that represent context the user attached, worth flagging to metrics. */
const ATTACHMENT_TAGS: ReadonlySet<string> = new Set([
  'attached_files',
  'code_selection',
  'image_files',
  'uploaded_documents',
  'external_links',
  'file',
]);

/**
 * Extract the real user intent from a raw user-message text (exported for
 * testing).
 *
 * - `<user_query>` content is the user's actual message; everything outside
 *   it is system-added and stripped. Attachment blocks are summarized as a
 *   short `[user attached: ...]` marker.
 * - Messages with no `<user_query>` are system-generated: plain text becomes
 *   `[system] ...`, tag-only content becomes `[system context: tag, ...]`,
 *   keeping them distinguishable from real user text for metrics.
 */
export function cleanUserText(raw: string): string {
  const queries: string[] = [];
  for (const match of raw.matchAll(USER_QUERY_RE)) {
    const body = (match[1] ?? '').trim();
    if (body.length > 0) queries.push(body);
  }

  const remainder = raw.replace(USER_QUERY_RE, '');
  const { text: strippedRemainder, tags } = stripTagBlocks(remainder);

  if (queries.length > 0) {
    const attachments = unique(tags.filter((t) => ATTACHMENT_TAGS.has(t)));
    let text = queries.join('\n\n');
    if (attachments.length > 0) {
      text += `\n\n[user attached: ${attachments.join(', ')}]`;
    }
    return text;
  }

  const plain = strippedRemainder.trim();
  if (plain.length > 0) return `[system] ${plain}`;
  const systemTags = unique(tags);
  if (systemTags.length > 0) return `[system context: ${systemTags.join(', ')}]`;
  return '';
}

const TAG_BLOCK_RE = /<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/;
const SELF_CLOSING_TAG_RE = /<([A-Za-z_][\w-]*)(?:\s[^>]*)?\/>/g;

/** Remove `<tag ...>...</tag>` and `<tag ... />` blocks, collecting tag names. */
function stripTagBlocks(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  let out = text;
  for (;;) {
    const match = TAG_BLOCK_RE.exec(out);
    if (match === null) break;
    tags.push(match[1] as string);
    out = out.slice(0, match.index) + out.slice(match.index + match[0].length);
  }
  out = out.replace(SELF_CLOSING_TAG_RE, (_whole, tag: string) => {
    tags.push(tag);
    return '';
  });
  return { text: out, tags };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Turn a project folder slug (path with `/` flattened to `-`) into a shorter
 * label by dropping the `Users-<name>-` home prefix. Special folders like
 * `empty-window` and numeric window ids pass through unchanged.
 */
export function friendlyProjectLabel(slug: string): string {
  const withoutHome = slug.replace(/^Users-[^-]+-/, '');
  return withoutHome.length > 0 ? withoutHome : slug;
}

function projectSlugFromTranscriptPath(
  transcriptPath: string,
  projectsDir: string,
): string | undefined {
  const relative = path.relative(projectsDir, transcriptPath);
  if (relative.startsWith('..')) return undefined;
  const slug = relative.split(path.sep)[0];
  return slug === undefined || slug.length === 0 ? undefined : slug;
}

/** Locate `<dir>/<uuid>.jsonl`, falling back to any `.jsonl` in the folder. */
async function findTranscriptFile(
  sessionDir: string,
  sessionDirName: string,
): Promise<string | undefined> {
  const expected = path.join(sessionDir, `${sessionDirName}.jsonl`);
  if (existsSync(expected)) return expected;
  try {
    const entries = await readdir(sessionDir);
    const jsonl = entries.find((name) => name.endsWith('.jsonl'));
    return jsonl === undefined ? undefined : path.join(sessionDir, jsonl);
  } catch {
    return undefined;
  }
}

/**
 * Cheap fallback title: parse the transcript only until the first real user
 * query is found and return its first line, truncated.
 */
async function firstUserQuerySnippet(transcriptPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }

  let fallback: string | undefined;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = parsed as { role?: unknown; message?: unknown };
    if (record.role !== 'user') continue;
    const content = (record.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const rawText = (content as RawContentItem[])
      .filter((i) => i !== null && typeof i === 'object' && i.type === 'text')
      .map((i) => (typeof i.text === 'string' ? i.text : ''))
      .join('\n\n');
    const cleaned = cleanUserText(rawText);
    if (cleaned.length === 0) continue;
    if (cleaned.startsWith('[system')) {
      fallback ??= snippetOf(cleaned);
      continue; // keep scanning for a real user query
    }
    return snippetOf(cleaned);
  }
  return fallback;
}

/** First line of a text, truncated to title length (shared with other adapters). */
export function snippetOf(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.length <= TITLE_SNIPPET_MAX_CHARS) return firstLine;
  return `${firstLine.slice(0, TITLE_SNIPPET_MAX_CHARS - 1)}…`;
}

/** Default Cursor source instance. */
export const cursorSource = new CursorSource();
