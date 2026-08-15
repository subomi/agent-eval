/**
 * Trajectory-backed `SessionSource`s: Claude Code and Codex, both built on
 * `@letta-ai/trajectory` — `listTrajectories()` for store discovery and
 * `normalizeTranscript()` for parsing — plus a shared records→Session folder.
 *
 * Folding: trajectory emits a flat record stream (one `meta`, then `user`,
 * assistant prose, `reasoning`, assistant `tool_calls`, and `tool` result
 * records). Our `Turn`s are role-alternating blocks, so consecutive
 * non-user records fold into one assistant turn that carries all its tool
 * calls; `tool` results attach to their call by `tool_call_id`
 * (`ToolCall.result`, `isError` from source-native `ok === false`) and never
 * open or close a turn. `reasoning` records are skipped — judges evaluate
 * visible behavior. Truncation is disabled (`maxCharacters: null`) so the
 * budgeting in `src/model/session.ts` stays authoritative.
 *
 * Real-data quirks handled here (verified against local stores):
 * - Neither store keeps a listing title. Claude Code writes
 *   `{"type":"ai-title","aiTitle":...}` rows into the raw JSONL (the last
 *   one wins); Codex has nothing, so the first real user message becomes
 *   the title, mirroring the Cursor adapter's fallback.
 * - Claude Code projects come from the store's path slug
 *   (`~/.claude/projects/<slug>/`); Codex projects from the `meta` record's
 *   `cwd` basename (with a raw `session_meta` scan as fallback for
 *   transcripts the normalizer rejects).
 * - Codex user records can still carry injected context that trajectory
 *   passes through: a leading `# AGENTS.md instructions … <INSTRUCTIONS>`
 *   blob and `<environment_context>`/`<user_instructions>` blocks. These are
 *   stripped; records that were pure injected context collapse to a
 *   `[system context: …]` marker (the Cursor adapter's convention).
 * - Sessions with no user or no assistant records (automation probes,
 *   empty shells) fail normalization with a NormalizationError;
 *   `loadSession` surfaces that as a readable error and callers already
 *   treat unreadable sessions as skippable.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import {
  listTrajectories,
  normalizeTranscript,
  type MetaRecord,
  type NormalizationBounds,
  type NormalizedRecord,
  type TrajectoryListing,
} from '@letta-ai/trajectory';

import type { Session, ToolCall, Turn } from '../model/session.js';
import { friendlyProjectLabel, snippetOf } from './cursor.js';
import type { ListSessionsOptions, SessionMeta, SessionSource } from './types.js';

/** Our own truncation (src/model/session.ts) stays authoritative. */
const NO_TRUNCATION: NormalizationBounds = {
  toolArguments: { maxCharacters: null },
  toolResults: { maxCharacters: null },
};

// ---------------------------------------------------------------------------
// Records → turns folding
// ---------------------------------------------------------------------------

export interface FoldedTranscript {
  turns: Turn[];
  /** The transcript's `meta` record (source, cwd, git_branch, model). */
  meta: MetaRecord | undefined;
}

/**
 * Fold trajectory's flat records into role-alternating turns (exported for
 * testing). `cleanUserText` is the source-specific injected-context scrub
 * applied to every user record; records it empties out are dropped.
 */
export function foldRecords(
  records: readonly NormalizedRecord[],
  cleanUserText: (raw: string) => string,
): FoldedTranscript {
  const turns: Turn[] = [];
  const callsById = new Map<string, ToolCall>();
  let meta: MetaRecord | undefined;
  let block: { role: 'user' | 'assistant'; textParts: string[]; toolCalls: ToolCall[] } | undefined;

  const flush = (): void => {
    if (block === undefined) return;
    const text = block.textParts.join('\n\n').trim();
    if (text.length > 0 || block.toolCalls.length > 0) {
      turns.push({ index: turns.length + 1, role: block.role, text, toolCalls: block.toolCalls });
    }
    block = undefined;
  };
  const ensure = (role: 'user' | 'assistant'): NonNullable<typeof block> => {
    if (block === undefined || block.role !== role) {
      flush();
      block = { role, textParts: [], toolCalls: [] };
    }
    return block;
  };

  for (const record of records) {
    switch (record.role) {
      case 'meta':
        meta = record;
        break;
      case 'reasoning':
        break; // judges evaluate visible behavior; reasoning stays out of turns
      case 'user': {
        const text = cleanUserText(record.content);
        if (text.length > 0) ensure('user').textParts.push(text);
        break;
      }
      case 'assistant': {
        if (record.content === null) {
          const current = ensure('assistant');
          for (const tc of record.tool_calls) {
            const call: ToolCall = { name: tc.name, input: parseToolArgs(tc.args) };
            current.toolCalls.push(call);
            callsById.set(tc.id, call);
          }
        } else if (record.content.trim().length > 0) {
          ensure('assistant').textParts.push(record.content.trim());
        }
        break;
      }
      case 'tool': {
        // Results attach to their call in place; they never open/close a turn.
        const call = callsById.get(record.tool_call_id);
        if (call !== undefined) {
          call.result = record.content;
          if (record.ok === false) call.isError = true;
        }
        break;
      }
    }
  }
  flush();
  return { turns, meta };
}

/** Tool args arrive as stringified JSON; unparseable args pass through raw. */
function parseToolArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

// ---------------------------------------------------------------------------
// Generic trajectory-backed source
// ---------------------------------------------------------------------------

interface TrajectorySourceSpec {
  id: string;
  name: string;
  /** Source id passed to the trajectory library. */
  trajectoryId: 'claude-code' | 'codex';
  /** Local store root; its existence defines availability. */
  storeDir: string;
  /** Cheap project derivation from a transcript path (Claude Code's slug). */
  projectFromPath(transcriptPath: string): string | undefined;
  /** Cheap title scan over the raw JSONL (Claude Code's ai-title rows). */
  titleFromRaw(raw: string): string | undefined;
  /** Fallback cwd scan for transcripts the normalizer rejects. */
  cwdFromRaw(raw: string): string | undefined;
  /** Strip source-native injected context out of one user record. */
  cleanUserText(raw: string): string;
  /** Session id from a listing id / file stem (Codex: trailing uuid). */
  sessionIdFromStem(stem: string): string;
}

export class TrajectorySource implements SessionSource {
  readonly id: string;
  readonly name: string;
  private readonly spec: TrajectorySourceSpec;

  constructor(spec: TrajectorySourceSpec) {
    this.spec = spec;
    this.id = spec.id;
    this.name = spec.name;
  }

  isAvailable(): boolean {
    return existsSync(this.spec.storeDir);
  }

  /**
   * List sessions, most recently updated first. Titles (and Codex projects)
   * require reading the transcript, so they are only derived for the
   * sessions that survive the limit cut — except under a `project` filter,
   * where projects must be known for everything first.
   */
  async listSessions(options: ListSessionsOptions = {}): Promise<SessionMeta[]> {
    const items = await this.listAll();

    // The freshest copy wins when a session id appears twice in the store.
    const byId = new Map<string, SessionMeta>();
    for (const item of items) {
      const id = this.spec.sessionIdFromStem(item.id);
      const updatedAt =
        item.updatedAt !== undefined ? new Date(item.updatedAt) : await fileMtime(item.path);
      const meta: SessionMeta = {
        id,
        agent: this.id,
        project: this.spec.projectFromPath(item.path) ?? '',
        title: '',
        updatedAt,
        transcriptPath: item.path,
      };
      const existing = byId.get(id);
      if (existing === undefined || meta.updatedAt.getTime() > existing.updatedAt.getTime()) {
        byId.set(id, meta);
      }
    }
    let metas = [...byId.values()];

    if (options.project !== undefined) {
      await Promise.all(
        metas.filter((m) => m.project.length === 0).map((m) => this.enrich(m, true)),
      );
      const wanted = options.project.toLowerCase();
      metas = metas.filter((m) => m.project.toLowerCase() === wanted);
    }

    metas.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (options.limit !== undefined) metas = metas.slice(0, options.limit);

    await Promise.all(metas.map((m) => this.enrich(m)));
    return metas;
  }

  async loadSession(ref: string | SessionMeta): Promise<Session> {
    const located = await this.resolveRef(ref);
    const rawBytes = await readFile(located.transcriptPath);
    const contentHash = createHash('sha256').update(rawBytes).digest('hex');
    const raw = rawBytes.toString('utf8');

    let records: NormalizedRecord[];
    try {
      records = this.normalize(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.name} session ${located.id} could not be normalized: ${message}`);
    }
    const { turns, meta } = foldRecords(records, this.spec.cleanUserText);

    let title = located.title ?? '';
    if (title.length === 0) {
      title =
        this.spec.titleFromRaw(raw) ??
        firstUserSnippet(records, this.spec.cleanUserText) ??
        'Untitled session';
    }
    let project = located.project ?? '';
    if (project.length === 0) {
      const cwd = meta?.cwd ?? this.spec.cwdFromRaw(raw);
      project = cwd !== undefined && cwd.length > 0 ? path.basename(cwd) : 'unknown';
    }
    const updatedAt = located.updatedAt ?? (await fileMtime(located.transcriptPath));

    return {
      id: located.id,
      agent: this.id,
      project,
      title,
      updatedAt,
      contentHash,
      transcriptPath: located.transcriptPath,
      turns,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async listAll(): Promise<TrajectoryListing[]> {
    const items: TrajectoryListing[] = [];
    let cursor: string | undefined;
    do {
      const page = await listTrajectories({
        source: this.spec.trajectoryId,
        limit: 200,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  }

  private normalize(raw: string): NormalizedRecord[] {
    return normalizeTranscript({
      source: this.spec.trajectoryId,
      transcript: raw,
      bounds: NO_TRUNCATION,
    }).records;
  }

  /**
   * Fill a meta's missing title/project (and turnCount when it falls out for
   * free) by reading the transcript once. `projectOnly` skips title work for
   * the pre-filter pass. Unreadable or unnormalizable transcripts degrade to
   * placeholder values instead of failing the listing.
   */
  private async enrich(meta: SessionMeta, projectOnly = false): Promise<void> {
    const needsTitle = !projectOnly && meta.title.length === 0;
    const needsProject = meta.project.length === 0;
    if (!needsTitle && !needsProject) return;

    let raw: string | undefined;
    try {
      raw = await readFile(meta.transcriptPath, 'utf8');
    } catch {
      raw = undefined;
    }

    if (raw !== undefined) {
      if (needsTitle) meta.title = this.spec.titleFromRaw(raw) ?? '';

      if ((needsTitle && meta.title.length === 0) || needsProject) {
        let records: NormalizedRecord[] | undefined;
        try {
          records = this.normalize(raw);
        } catch {
          records = undefined;
        }
        if (records !== undefined) {
          const folded = foldRecords(records, this.spec.cleanUserText);
          if (needsTitle && meta.title.length === 0) {
            meta.title = firstUserSnippet(records, this.spec.cleanUserText) ?? '';
          }
          if (needsProject && folded.meta?.cwd !== undefined && folded.meta.cwd.length > 0) {
            meta.project = path.basename(folded.meta.cwd);
          }
          if (meta.turnCount === undefined) meta.turnCount = folded.turns.length;
        }
        if (needsProject && meta.project.length === 0) {
          const cwd = this.spec.cwdFromRaw(raw);
          if (cwd !== undefined) meta.project = path.basename(cwd);
        }
      }
    }

    if (needsTitle && meta.title.length === 0) meta.title = 'Untitled session';
    if (meta.project.length === 0) meta.project = 'unknown';
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
        throw new Error(`${this.name} transcript not found at path: ${ref}`);
      }
      const resolved = path.resolve(ref);
      const out: { id: string; transcriptPath: string; project?: string } = {
        id: this.spec.sessionIdFromStem(path.basename(resolved, '.jsonl')),
        transcriptPath: resolved,
      };
      const project = this.spec.projectFromPath(resolved);
      if (project !== undefined) out.project = project;
      return out;
    }

    // A session id: match the listing id or its extracted session id.
    const match = (await this.listAll()).find(
      (item) => item.id === ref || this.spec.sessionIdFromStem(item.id) === ref,
    );
    if (match === undefined) {
      throw new Error(
        `No ${this.name} session found for id "${ref}" under ${this.spec.storeDir}`,
      );
    }
    const out: { id: string; transcriptPath: string; project?: string } = {
      id: this.spec.sessionIdFromStem(match.id),
      transcriptPath: match.path,
    };
    const project = this.spec.projectFromPath(match.path);
    if (project !== undefined) out.project = project;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Shared derivation helpers
// ---------------------------------------------------------------------------

/**
 * Title fallback: the first user record whose cleaned text is real user
 * input; `[system …]` markers only win when nothing better exists.
 */
function firstUserSnippet(
  records: readonly NormalizedRecord[],
  cleanUserText: (raw: string) => string,
): string | undefined {
  let fallback: string | undefined;
  for (const record of records) {
    if (record.role !== 'user') continue;
    const text = cleanUserText(record.content);
    if (text.length === 0) continue;
    if (text.startsWith('[system')) {
      fallback ??= snippetOf(text);
      continue;
    }
    return snippetOf(text);
  }
  return fallback;
}

async function fileMtime(filePath: string): Promise<Date> {
  try {
    return new Date((await stat(filePath)).mtimeMs);
  } catch {
    return new Date(0);
  }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const CLAUDE_STORE_DIR = path.join(homedir(), '.claude', 'projects');

/** Last `{"type":"ai-title","aiTitle":…}` row wins (retitles append). */
function claudeTitleFromRaw(raw: string): string | undefined {
  let title: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line.includes('"type":"ai-title"')) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
      if (parsed.type === 'ai-title' && typeof parsed.aiTitle === 'string') {
        const trimmed = parsed.aiTitle.trim();
        if (trimmed.length > 0) title = trimmed;
      }
    } catch {
      // malformed line; keep scanning
    }
  }
  return title;
}

function claudeProjectFromPath(transcriptPath: string): string | undefined {
  const relative = path.relative(CLAUDE_STORE_DIR, transcriptPath);
  if (relative.startsWith('..')) return undefined;
  const slug = relative.split(path.sep)[0];
  if (slug === undefined || slug.length === 0) return undefined;
  // Claude slugs flatten the absolute cwd with a leading "-": "-Users-me-code-x".
  return friendlyProjectLabel(slug.replace(/^-+/, ''));
}

export const claudeCodeSource = new TrajectorySource({
  id: 'claude-code',
  name: 'Claude Code',
  trajectoryId: 'claude-code',
  storeDir: CLAUDE_STORE_DIR,
  projectFromPath: claudeProjectFromPath,
  titleFromRaw: claudeTitleFromRaw,
  cwdFromRaw: () => undefined,
  cleanUserText: (raw) => raw.trim(),
  sessionIdFromStem: (stem) => stem,
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_STORE_DIR = path.join(homedir(), '.codex', 'sessions');

/** Codex file stems are `rollout-<timestamp>-<uuid>`; the uuid is the session id. */
const UUID_SUFFIX_RE = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const CODEX_INJECTED_BLOCK_RE =
  /<(environment_context|user_instructions|ide_context|turn_aborted)>[\s\S]*?<\/\1>/g;
const CODEX_AGENTS_MD_RE =
  /(?:^|\n)#+\s*AGENTS\.md instructions[^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g;

/**
 * Strip injected context trajectory passes through in Codex user records
 * (exported for testing). Records that were pure injected context collapse
 * to a `[system context: …]` marker, mirroring the Cursor adapter.
 */
export function cleanCodexUserText(raw: string): string {
  const tags: string[] = [];
  let out = raw.replace(CODEX_AGENTS_MD_RE, () => {
    tags.push('AGENTS.md instructions');
    return '';
  });
  out = out.replace(CODEX_INJECTED_BLOCK_RE, (_match, tag: string) => {
    tags.push(tag);
    return '';
  });
  out = out.trim();
  if (out.length > 0) return out;
  const unique = [...new Set(tags)];
  return unique.length > 0 ? `[system context: ${unique.join(', ')}]` : '';
}

/** First `session_meta` line's `payload.cwd`, for unnormalizable transcripts. */
function codexCwdFromRaw(raw: string): string | undefined {
  for (const line of raw.split('\n', 20)) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const parsed = JSON.parse(line) as { payload?: { cwd?: unknown } };
      const cwd = parsed.payload?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    } catch {
      // malformed line; keep scanning
    }
  }
  return undefined;
}

export const codexSource = new TrajectorySource({
  id: 'codex',
  name: 'Codex',
  trajectoryId: 'codex',
  storeDir: CODEX_STORE_DIR,
  projectFromPath: () => undefined,
  titleFromRaw: () => undefined,
  cwdFromRaw: codexCwdFromRaw,
  cleanUserText: cleanCodexUserText,
  sessionIdFromStem: (stem) => UUID_SUFFIX_RE.exec(stem)?.[0] ?? stem,
});
