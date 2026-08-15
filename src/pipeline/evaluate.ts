/**
 * Shared evaluation engine used by both `agent-evals eval` (a batch of one)
 * and `agent-evals batch`.
 *
 * Idempotency: a (content_hash, metric_id, metric_version, judge_model)
 * tuple is evaluated at most once — existing `metric_results` rows are
 * served from the DB, `--force` re-runs and replaces them. Results are
 * written per metric as each completes, so an interrupted run resumes where
 * it stopped.
 *
 * Directive extraction seam: the pipeline accepts an optional
 * `DirectiveExtractor` (implemented in `src/extract/directives.ts`). When
 * provided, sessions whose (content_hash, extractor_version) pair has no
 * completed extraction pass yet (zero-directive passes count as completed)
 * get one extraction, written atomically to the `directives` table.
 */

import type { Judge } from '../judge/types.js';
import type { Finding, Metric, MetricResult, MetricTarget } from '../metrics/index.js';
import { computeSessionStats, type Session, type SessionStats } from '../model/session.js';
import type { DirectiveRow, EvalsDb, MetricResultRow } from '../store/db.js';

// ---------------------------------------------------------------------------
// Run record (the `--json` artifact, rebuilt from DB rows)
// ---------------------------------------------------------------------------

/**
 * v2: findings are structured — optional `label` (judged subject) and
 * `status` (verdict) fields alongside `note`.
 */
export const RUN_SCHEMA_VERSION = 2;

export interface RunMetricRecord {
  id: string;
  version: number;
  name: string;
  target: MetricTarget;
  /** 0 (worst) to 1 (best). */
  score: number;
  findings: Finding[];
  advice: string[];
}

export interface RunRecord {
  schemaVersion: number;
  sessionId: string;
  agent: string;
  project: string;
  title: string;
  /** ISO-8601 timestamp of when this record was assembled. */
  evaluatedAt: string;
  /** Judge model as "provider/model-id". */
  model: string;
  sessionStats: SessionStats;
  metrics: RunMetricRecord[];
  /** Unweighted average of the metric scores. */
  overallScore: number;
}

// ---------------------------------------------------------------------------
// Directive extraction seam
// ---------------------------------------------------------------------------

export interface ExtractedDirective {
  turnRef: number;
  kind: DirectiveRow['kind'];
  text: string;
}

/**
 * Per-session directive-extraction pass (a judge call, not a scored metric).
 * `src/extract/directives.ts` will implement this; `extractorVersion` is
 * part of the idempotency check so re-extraction happens only when the
 * extractor itself changes.
 */
export interface DirectiveExtractor {
  readonly version: number;
  extract(session: Session, judge: Judge): Promise<ExtractedDirective[]>;
}

// ---------------------------------------------------------------------------
// Work planning (shared by --dry-run and the real run)
// ---------------------------------------------------------------------------

export interface SessionWorkPlan {
  session: Session;
  stats: SessionStats;
  /** Metric pairs that need a judge run (everything, with `force`). */
  toRun: Metric[];
  /** Metric pairs already satisfied by a stored row. */
  cached: { metric: Metric; row: MetricResultRow }[];
}

export function planSessionWork(
  db: EvalsDb,
  session: Session,
  metrics: readonly Metric[],
  judgeModel: string,
  force: boolean,
): SessionWorkPlan {
  const toRun: Metric[] = [];
  const cached: { metric: Metric; row: MetricResultRow }[] = [];
  for (const metric of metrics) {
    const row = force
      ? undefined
      : db.getMetricResult(session.contentHash, metric.id, metric.version, judgeModel);
    if (row === undefined) toRun.push(metric);
    else cached.push({ metric, row });
  }
  return { session, stats: computeSessionStats(session), toRun, cached };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type MetricRunStatus = 'evaluated' | 'cached' | 'failed';

export interface MetricOutcome {
  metric: Metric;
  status: MetricRunStatus;
  /** Present unless `status` is "failed". */
  row?: MetricResultRow;
  error?: unknown;
}

export type DirectiveOutcome = 'extracted' | 'cached' | 'failed';

export interface SessionOutcome {
  session: Session;
  stats: SessionStats;
  /** One entry per requested metric, in canonical registry order. */
  outcomes: MetricOutcome[];
  /** Assembled from DB rows; undefined when every metric failed. */
  run: RunRecord | undefined;
  /** Only set when the pipeline ran with a directive extractor. */
  directives?: DirectiveOutcome;
}

export interface PipelineEvents {
  /** A session is about to be processed; `plan` shows run/cached splits. */
  onSessionStart?(info: { index: number; total: number; plan: SessionWorkPlan }): void;
  /** A metric settled (evaluated, cache-served, or failed) for a session. */
  onMetricSettled?(info: {
    index: number;
    total: number;
    session: Session;
    outcome: MetricOutcome;
    settledCount: number;
    metricCount: number;
  }): void;
  /** All metrics for a session settled and its rows are on disk. */
  onSessionDone?(info: { index: number; total: number; outcome: SessionOutcome }): void;
}

export interface EvaluatePipelineOptions {
  db: EvalsDb;
  judge: Judge;
  /** Resolved judge model ref, part of the idempotency key. */
  judgeModel: string;
  metrics: readonly Metric[];
  /** Re-run and replace metric pairs that already have rows. */
  force?: boolean;
  /** Optional per-session directive-extraction pass (see seam note above). */
  extractor?: DirectiveExtractor;
  events?: PipelineEvents;
}

/**
 * Evaluate sessions sequentially (metrics within a session run concurrently;
 * the judge bounds real API concurrency with its internal pool). Every
 * session row is upserted even when all its metric pairs are cache hits.
 */
export async function evaluateSessions(
  sessions: readonly Session[],
  options: EvaluatePipelineOptions,
): Promise<SessionOutcome[]> {
  const results: SessionOutcome[] = [];
  for (let i = 0; i < sessions.length; i += 1) {
    results.push(await evaluateOneSession(sessions[i]!, i, sessions.length, options));
  }
  return results;
}

async function evaluateOneSession(
  session: Session,
  index: number,
  total: number,
  options: EvaluatePipelineOptions,
): Promise<SessionOutcome> {
  const { db, judge, judgeModel, metrics, events } = options;
  const force = options.force ?? false;
  const now = new Date().toISOString();

  const plan = planSessionWork(db, session, metrics, judgeModel, force);
  db.upsertSession(
    {
      sessionId: session.id,
      agent: session.agent,
      project: session.project,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
      transcriptPath: session.transcriptPath,
      contentHash: session.contentHash,
      stats: plan.stats,
    },
    now,
  );
  events?.onSessionStart?.({ index, total, plan });

  const metricCount = metrics.length;
  let settledCount = 0;
  const settled = new Map<string, MetricOutcome>();
  const settle = (outcome: MetricOutcome): void => {
    settled.set(outcome.metric.id, outcome);
    settledCount += 1;
    events?.onMetricSettled?.({ index, total, session, outcome, settledCount, metricCount });
  };

  for (const { metric, row } of plan.cached) {
    settle({ metric, status: 'cached', row });
  }

  await Promise.all(
    plan.toRun.map(async (metric) => {
      try {
        const result: MetricResult = await metric.evaluate(session, judge);
        const row: MetricResultRow = {
          sessionId: session.id,
          contentHash: session.contentHash,
          metricId: metric.id,
          metricVersion: metric.version,
          judgeModel,
          score: result.score,
          findings: result.findings,
          advice: result.advice,
          evaluatedAt: new Date().toISOString(),
        };
        db.upsertMetricResult(row); // per-metric write: crash-safe resume
        settle({ metric, status: 'evaluated', row });
      } catch (error) {
        settle({ metric, status: 'failed', error });
      }
    }),
  );

  const outcomes = metrics.map((m) => settled.get(m.id)!);
  if (outcomes.some((o) => o.status === 'evaluated')) {
    db.markSessionEvaluated(session.id, new Date().toISOString());
  }

  const outcome: SessionOutcome = {
    session,
    stats: plan.stats,
    outcomes,
    run: buildRunRecord(session, plan.stats, judgeModel, outcomes, metrics),
  };

  if (options.extractor !== undefined) {
    outcome.directives = await runExtractor(session, options.extractor, { db, judge, force });
  }

  events?.onSessionDone?.({ index, total, outcome });
  return outcome;
}

async function runExtractor(
  session: Session,
  extractor: DirectiveExtractor,
  ctx: { db: EvalsDb; judge: Judge; force: boolean },
): Promise<DirectiveOutcome> {
  if (!ctx.force && ctx.db.hasDirectives(session.contentHash, extractor.version)) {
    return 'cached';
  }
  try {
    const extracted = await extractor.extract(session, ctx.judge);
    ctx.db.replaceDirectives(
      session.contentHash,
      extractor.version,
      extracted.map((d) => ({
        sessionId: session.id,
        contentHash: session.contentHash,
        turnRef: d.turnRef,
        kind: d.kind,
        text: d.text,
        extractorVersion: extractor.version,
      })),
    );
    return 'extracted';
  } catch {
    return 'failed';
  }
}

/** Assemble the `--json` run record from the rows that made it to the DB. */
export function buildRunRecord(
  session: Session,
  stats: SessionStats,
  judgeModel: string,
  outcomes: readonly MetricOutcome[],
  metricOrder: readonly Metric[],
): RunRecord | undefined {
  const byId = new Map(outcomes.map((o) => [o.metric.id, o]));
  const records: RunMetricRecord[] = [];
  for (const metric of metricOrder) {
    const row = byId.get(metric.id)?.row;
    if (row === undefined) continue;
    records.push({
      id: metric.id,
      version: metric.version,
      name: metric.name,
      target: metric.target,
      score: row.score,
      findings: row.findings,
      advice: row.advice,
    });
  }
  if (records.length === 0) return undefined;

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    sessionId: session.id,
    agent: session.agent,
    project: session.project,
    title: session.title,
    evaluatedAt: new Date().toISOString(),
    model: judgeModel,
    sessionStats: stats,
    metrics: records,
    overallScore: records.reduce((sum, m) => sum + m.score, 0) / records.length,
  };
}
