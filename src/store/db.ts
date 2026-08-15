/**
 * SQLite source of truth at `~/.agent-evals/agent-evals.db` (builtin
 * `node:sqlite`, WAL mode). Schema v1:
 *
 * - `sessions` — one row per known session, upserted on every evaluation;
 *   carries the full `SessionStats` JSON plus denormalized columns that the
 *   insights command reads without JSON parsing.
 * - `metric_results` — one row per (content_hash, metric_id, metric_version,
 *   judge_model): the UNIQUE index on that tuple is the idempotency key.
 *   Rows are written per metric as each completes, so a crashed batch
 *   resumes for free.
 * - `directives` — extracted user directives for repetition hotspots.
 * - `directive_extractions` — one marker row per completed extraction pass
 *   (content_hash, extractor_version). The marker — not the presence of
 *   `directives` rows — is the idempotency check, because an extraction
 *   that finds zero directives must still count as done. Markers and rows
 *   are written in one transaction.
 * - `meta` — schema_version for future migrations.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Finding, MetricTarget } from '../metrics/index.js';
import type { SessionStats } from '../model/session.js';

export const DB_SCHEMA_VERSION = 1;

export function defaultDbPath(): string {
  return join(homedir(), '.agent-evals', 'agent-evals.db');
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface SessionRow {
  sessionId: string;
  agent: string;
  project: string;
  title: string;
  /** ISO-8601 last activity in the session (from the source adapter). */
  updatedAt: string;
  transcriptPath: string;
  contentHash: string;
  stats: SessionStats;
  /** ISO-8601 of when this row first appeared. */
  firstSeenAt: string;
  /** ISO-8601 of the last time a metric was evaluated (not cache-served). */
  lastEvaluatedAt: string | null;
}

export interface MetricResultRow {
  sessionId: string;
  contentHash: string;
  metricId: string;
  metricVersion: number;
  judgeModel: string;
  /** 0 (worst) to 1 (best). */
  score: number;
  findings: Finding[];
  advice: string[];
  /** ISO-8601 of when the judge produced this result. */
  evaluatedAt: string;
}

export interface DirectiveRow {
  sessionId: string;
  contentHash: string;
  turnRef: number;
  kind: 'instruction' | 'preference' | 'correction';
  text: string;
  extractorVersion: number;
}

/** Re-exported for callers that render results without the metric registry. */
export type { Finding, MetricTarget };

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  session_id             TEXT PRIMARY KEY,
  agent                  TEXT NOT NULL,
  project                TEXT NOT NULL,
  title                  TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  transcript_path        TEXT NOT NULL,
  content_hash           TEXT NOT NULL,
  stats_json             TEXT NOT NULL,
  turn_count             INTEGER NOT NULL,
  user_turn_count        INTEGER NOT NULL,
  tool_call_count        INTEGER NOT NULL,
  failed_tool_call_count INTEGER NOT NULL,
  steering_count         INTEGER NOT NULL,
  first_seen_at          TEXT NOT NULL,
  last_evaluated_at      TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS metric_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  metric_id      TEXT NOT NULL,
  metric_version INTEGER NOT NULL,
  judge_model    TEXT NOT NULL,
  score          REAL NOT NULL,
  findings_json  TEXT NOT NULL,
  advice_json    TEXT NOT NULL,
  evaluated_at   TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_results_idempotency
  ON metric_results (content_hash, metric_id, metric_version, judge_model);
CREATE INDEX IF NOT EXISTS idx_metric_results_session
  ON metric_results (session_id);

CREATE TABLE IF NOT EXISTS directives (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  turn_ref          INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('instruction', 'preference', 'correction')),
  text              TEXT NOT NULL,
  extractor_version INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_directives_hash_version
  ON directives (content_hash, extractor_version);

CREATE TABLE IF NOT EXISTS directive_extractions (
  content_hash      TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  extracted_at      TEXT NOT NULL,
  directive_count   INTEGER NOT NULL,
  PRIMARY KEY (content_hash, extractor_version)
) STRICT;

-- Backfill markers for directives written before the marker table existed.
INSERT OR IGNORE INTO directive_extractions
  (content_hash, extractor_version, extracted_at, directive_count)
  SELECT content_hash, extractor_version,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COUNT(*)
  FROM directives GROUP BY content_hash, extractor_version;
`;

export class EvalsDb {
  private readonly db: DatabaseSync;

  constructor(path: string = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA_SQL);
    this.db
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(DB_SCHEMA_VERSION));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // -- sessions --------------------------------------------------------------

  /** Insert or refresh a session row; `first_seen_at` is preserved on update. */
  upsertSession(row: Omit<SessionRow, 'firstSeenAt' | 'lastEvaluatedAt'>, now: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
           session_id, agent, project, title, updated_at, transcript_path,
           content_hash, stats_json, turn_count, user_turn_count,
           tool_call_count, failed_tool_call_count, steering_count, first_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           agent = excluded.agent,
           project = excluded.project,
           title = excluded.title,
           updated_at = excluded.updated_at,
           transcript_path = excluded.transcript_path,
           content_hash = excluded.content_hash,
           stats_json = excluded.stats_json,
           turn_count = excluded.turn_count,
           user_turn_count = excluded.user_turn_count,
           tool_call_count = excluded.tool_call_count,
           failed_tool_call_count = excluded.failed_tool_call_count,
           steering_count = excluded.steering_count`,
      )
      .run(
        row.sessionId,
        row.agent,
        row.project,
        row.title,
        row.updatedAt,
        row.transcriptPath,
        row.contentHash,
        JSON.stringify(row.stats),
        row.stats.turnCount,
        row.stats.userTurnCount,
        row.stats.toolCallCount,
        row.stats.failedToolCallCount,
        row.stats.userSteeringMessageCount,
        now,
      );
  }

  markSessionEvaluated(sessionId: string, at: string): void {
    this.db
      .prepare('UPDATE sessions SET last_evaluated_at = ? WHERE session_id = ?')
      .run(at, sessionId);
  }

  /**
   * All session rows (insights reads everything and computes in TS).
   * `project` matches the stored project label case-insensitively;
   * `sinceIso` keeps sessions with `updated_at >= sinceIso`; `agents`
   * restricts to sessions from those agent ids.
   */
  listSessions(
    filter: { project?: string; sinceIso?: string; agents?: readonly string[] } = {},
  ): SessionRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.project !== undefined) {
      clauses.push('LOWER(project) = LOWER(?)');
      params.push(filter.project);
    }
    if (filter.sinceIso !== undefined) {
      clauses.push('updated_at >= ?');
      params.push(filter.sinceIso);
    }
    if (filter.agents !== undefined && filter.agents.length > 0) {
      clauses.push(`agent IN (${filter.agents.map(() => '?').join(', ')})`);
      params.push(...filter.agents);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const raws = this.db
      .prepare(
        `SELECT session_id, agent, project, title, updated_at, transcript_path,
                content_hash, stats_json, first_seen_at, last_evaluated_at
         FROM sessions${where} ORDER BY updated_at`,
      )
      .all(...params) as Record<string, unknown>[];
    return raws.map((raw) => ({
      sessionId: String(raw['session_id']),
      agent: String(raw['agent']),
      project: String(raw['project']),
      title: String(raw['title']),
      updatedAt: String(raw['updated_at']),
      transcriptPath: String(raw['transcript_path']),
      contentHash: String(raw['content_hash']),
      stats: JSON.parse(String(raw['stats_json'])) as SessionStats,
      firstSeenAt: String(raw['first_seen_at']),
      lastEvaluatedAt: raw['last_evaluated_at'] === null ? null : String(raw['last_evaluated_at']),
    }));
  }

  // -- metric_results ----------------------------------------------------------

  /** Look up a result by the idempotency key; undefined = not evaluated yet. */
  getMetricResult(
    contentHash: string,
    metricId: string,
    metricVersion: number,
    judgeModel: string,
  ): MetricResultRow | undefined {
    const raw = this.db
      .prepare(
        `SELECT session_id, content_hash, metric_id, metric_version, judge_model,
                score, findings_json, advice_json, evaluated_at
         FROM metric_results
         WHERE content_hash = ? AND metric_id = ? AND metric_version = ? AND judge_model = ?`,
      )
      .get(contentHash, metricId, metricVersion, judgeModel) as
      | Record<string, unknown>
      | undefined;
    return raw === undefined ? undefined : toMetricResultRow(raw);
  }

  /**
   * Write one metric result. On idempotency-key conflict (a `--force`
   * re-run) the row is replaced in place, keeping one row per key.
   */
  upsertMetricResult(row: MetricResultRow): void {
    this.db
      .prepare(
        `INSERT INTO metric_results (
           session_id, content_hash, metric_id, metric_version, judge_model,
           score, findings_json, advice_json, evaluated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (content_hash, metric_id, metric_version, judge_model) DO UPDATE SET
           session_id = excluded.session_id,
           score = excluded.score,
           findings_json = excluded.findings_json,
           advice_json = excluded.advice_json,
           evaluated_at = excluded.evaluated_at`,
      )
      .run(
        row.sessionId,
        row.contentHash,
        row.metricId,
        row.metricVersion,
        row.judgeModel,
        row.score,
        JSON.stringify(row.findings),
        JSON.stringify(row.advice),
        row.evaluatedAt,
      );
  }

  /** All metric result rows, oldest evaluation first (insights joins in TS). */
  listMetricResults(): MetricResultRow[] {
    const raws = this.db
      .prepare(
        `SELECT session_id, content_hash, metric_id, metric_version, judge_model,
                score, findings_json, advice_json, evaluated_at
         FROM metric_results ORDER BY evaluated_at, id`,
      )
      .all() as Record<string, unknown>[];
    return raws.map(toMetricResultRow);
  }

  /** Number of distinct metrics with a stored result for this transcript state. */
  countEvaluatedMetrics(contentHash: string): number {
    const raw = this.db
      .prepare('SELECT COUNT(DISTINCT metric_id) AS n FROM metric_results WHERE content_hash = ?')
      .get(contentHash) as Record<string, unknown> | undefined;
    return typeof raw?.['n'] === 'number' ? raw['n'] : Number(raw?.['n'] ?? 0);
  }

  // -- directives --------------------------------------------------------------

  /**
   * True when an extraction pass already completed for this transcript
   * state and extractor version — including passes that found zero
   * directives (the marker row is what counts, not the directive rows).
   */
  hasDirectives(contentHash: string, extractorVersion: number): boolean {
    const raw = this.db
      .prepare(
        'SELECT 1 AS one FROM directive_extractions WHERE content_hash = ? AND extractor_version = ?',
      )
      .get(contentHash, extractorVersion);
    return raw !== undefined;
  }

  /**
   * Replace this session's directives for one extractor version atomically
   * (delete + insert + completion marker in a transaction), so a crash
   * never leaves a partial set behind that would defeat the marker check.
   */
  replaceDirectives(
    contentHash: string,
    extractorVersion: number,
    rows: readonly DirectiveRow[],
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO directives (session_id, content_hash, turn_ref, kind, text, extractor_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('DELETE FROM directives WHERE content_hash = ? AND extractor_version = ?')
        .run(contentHash, extractorVersion);
      for (const row of rows) {
        insert.run(
          row.sessionId,
          row.contentHash,
          row.turnRef,
          row.kind,
          row.text,
          row.extractorVersion,
        );
      }
      this.db
        .prepare(
          `INSERT INTO directive_extractions
             (content_hash, extractor_version, extracted_at, directive_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (content_hash, extractor_version) DO UPDATE SET
             extracted_at = excluded.extracted_at,
             directive_count = excluded.directive_count`,
        )
        .run(contentHash, extractorVersion, new Date().toISOString(), rows.length);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDirectives(filter: { contentHash?: string; extractorVersion?: number } = {}): DirectiveRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.contentHash !== undefined) {
      clauses.push('content_hash = ?');
      params.push(filter.contentHash);
    }
    if (filter.extractorVersion !== undefined) {
      clauses.push('extractor_version = ?');
      params.push(filter.extractorVersion);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const raws = this.db
      .prepare(
        `SELECT session_id, content_hash, turn_ref, kind, text, extractor_version
         FROM directives${where} ORDER BY id`,
      )
      .all(...params) as Record<string, unknown>[];
    return raws.map((raw) => ({
      sessionId: String(raw['session_id']),
      contentHash: String(raw['content_hash']),
      turnRef: Number(raw['turn_ref']),
      kind: String(raw['kind']) as DirectiveRow['kind'],
      text: String(raw['text']),
      extractorVersion: Number(raw['extractor_version']),
    }));
  }
}

function toMetricResultRow(raw: Record<string, unknown>): MetricResultRow {
  return {
    sessionId: String(raw['session_id']),
    contentHash: String(raw['content_hash']),
    metricId: String(raw['metric_id']),
    metricVersion: Number(raw['metric_version']),
    judgeModel: String(raw['judge_model']),
    score: Number(raw['score']),
    findings: JSON.parse(String(raw['findings_json'])) as Finding[],
    advice: JSON.parse(String(raw['advice_json'])) as string[],
    evaluatedAt: String(raw['evaluated_at']),
  };
}

/** Open (creating if needed) the default database. */
export function openDb(path?: string): EvalsDb {
  return new EvalsDb(path);
}
