/**
 * Weekly trend computation, all at read time from DB rows.
 *
 * - Deterministic trends come from the denormalized `sessions` stats (plus
 *   `stats_json` for repeated tool calls) — no judge involvement, so they
 *   are noise-free and comparable across judge/model changes.
 * - Judged trends are per-metric weekly medians of stored scores, split by
 *   cohort (metric_version + judge_model). Scores are NEVER averaged across
 *   cohorts: a version or judge change starts a new segment.
 *
 * Buckets use the week of the session's activity (`updated_at`), not the
 * evaluation time — a backfill batch must not pile history into one week.
 */

import { allMetrics, type MetricTarget } from '../metrics/index.js';
import type { MetricResultRow, SessionRow } from '../store/db.js';
import type {
  CohortSegment,
  DeterministicTrend,
  JudgedMetricTrend,
  WeekPoint,
} from './types.js';
import { isoWeekKey, isoWeekStart } from './week.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function weekOf(iso: string): { key: string; start: string } {
  const date = new Date(iso);
  return { key: isoWeekKey(date), start: isoWeekStart(date).toISOString().slice(0, 10) };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function sortedWeekPoints(byWeek: Map<string, { start: string; values: number[] }>): WeekPoint[] {
  return [...byWeek.entries()]
    .sort((a, b) => (a[1].start < b[1].start ? -1 : 1))
    .map(([week, bucket]) => ({
      week,
      weekStart: bucket.start,
      value: median(bucket.values),
      n: bucket.values.length,
    }));
}

// ---------------------------------------------------------------------------
// Deterministic trends
// ---------------------------------------------------------------------------

interface WeekAggregate {
  start: string;
  sessions: number;
  /** Per-session turn counts — turns/session uses the median so one huge
   * outlier session cannot swing the whole week. */
  turnCounts: number[];
  userTurns: number;
  steering: number;
  toolCalls: number;
  failedToolCalls: number;
  /** Extra invocations beyond the first for identical (name+input) calls. */
  redundantToolCalls: number;
}

/** Extra occurrences beyond the first, per identical (name + input) group. */
function redundantCallCount(session: SessionRow): number {
  return session.stats.repeatedToolCalls.reduce((sum, group) => sum + (group.count - 1), 0);
}

export function computeDeterministicTrends(sessions: readonly SessionRow[]): DeterministicTrend[] {
  const byWeek = new Map<string, WeekAggregate>();
  for (const session of sessions) {
    const { key, start } = weekOf(session.updatedAt);
    const agg = byWeek.get(key) ?? {
      start,
      sessions: 0,
      turnCounts: [] as number[],
      userTurns: 0,
      steering: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      redundantToolCalls: 0,
    };
    agg.sessions += 1;
    agg.turnCounts.push(session.stats.turnCount);
    agg.userTurns += session.stats.userTurnCount;
    agg.steering += session.stats.userSteeringMessageCount;
    agg.toolCalls += session.stats.toolCallCount;
    agg.failedToolCalls += session.stats.failedToolCallCount;
    agg.redundantToolCalls += redundantCallCount(session);
    byWeek.set(key, agg);
  }

  const ordered = [...byWeek.entries()].sort((a, b) => (a[1].start < b[1].start ? -1 : 1));
  const points = (value: (agg: WeekAggregate) => number): WeekPoint[] =>
    ordered.map(([week, agg]) => ({
      week,
      weekStart: agg.start,
      value: value(agg),
      n: agg.sessions,
    }));
  const ratio = (num: number, denom: number): number => (denom === 0 ? 0 : num / denom);

  const specs: {
    id: DeterministicTrend['id'];
    label: string;
    unit: 'ratio' | 'count';
    value: (agg: WeekAggregate) => number;
  }[] = [
    {
      id: 'steering-rate',
      label: 'steering rate',
      unit: 'ratio',
      value: (a) => ratio(a.steering, a.userTurns),
    },
    {
      id: 'turns-per-session',
      label: 'median turns / session',
      unit: 'count',
      value: (a) => median(a.turnCounts),
    },
    {
      id: 'tool-failure-rate',
      label: 'tool-failure rate',
      unit: 'ratio',
      value: (a) => ratio(a.failedToolCalls, a.toolCalls),
    },
    {
      id: 'repeated-tool-call-rate',
      label: 'repeated-tool-call rate',
      unit: 'ratio',
      value: (a) => ratio(a.redundantToolCalls, a.toolCalls),
    },
  ];

  return specs.map((spec) => {
    const weeks = points(spec.value);
    const latest = weeks.at(-1)?.value ?? null;
    const previous = weeks.at(-2)?.value ?? null;
    let direction: DeterministicTrend['direction'] = null;
    if (latest !== null && previous !== null) {
      const epsilon = spec.unit === 'ratio' ? 0.0005 : 0.05;
      direction =
        latest > previous + epsilon ? 'up' : latest < previous - epsilon ? 'down' : 'flat';
    }
    return {
      id: spec.id,
      label: spec.label,
      unit: spec.unit,
      weeks,
      latest,
      previous,
      direction,
      lowerIsBetter: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Judged trends
// ---------------------------------------------------------------------------

/**
 * One score per (session, metric, cohort): when a session was re-evaluated
 * after its transcript grew (new content_hash), only the newest evaluation
 * counts, so a session never appears twice inside one cohort's series.
 */
export function dedupeResults(rows: readonly MetricResultRow[]): MetricResultRow[] {
  const latest = new Map<string, MetricResultRow>();
  for (const row of rows) {
    const key = `${row.sessionId}\u0000${row.metricId}\u0000${row.metricVersion}\u0000${row.judgeModel}`;
    const existing = latest.get(key);
    if (existing === undefined || existing.evaluatedAt < row.evaluatedAt) latest.set(key, row);
  }
  return [...latest.values()];
}

export function computeJudgedTrends(
  results: readonly MetricResultRow[],
  sessionsById: ReadonlyMap<string, SessionRow>,
): JudgedMetricTrend[] {
  const registry = new Map(allMetrics.map((m) => [m.id, m]));

  // metric -> cohort -> week buckets of scores.
  const byMetric = new Map<string, Map<string, { rows: MetricResultRow[] }>>();
  for (const row of dedupeResults(results)) {
    if (!sessionsById.has(row.sessionId)) continue; // out of filter scope
    const cohortKey = `${row.metricVersion}\u0000${row.judgeModel}`;
    const cohorts = byMetric.get(row.metricId) ?? new Map();
    const cohort = cohorts.get(cohortKey) ?? { rows: [] };
    cohort.rows.push(row);
    cohorts.set(cohortKey, cohort);
    byMetric.set(row.metricId, cohorts);
  }

  const metricOrder = [
    ...allMetrics.map((m) => m.id),
    ...[...byMetric.keys()].filter((id) => !registry.has(id)).sort(),
  ];

  const trends: JudgedMetricTrend[] = [];
  for (const metricId of metricOrder) {
    const cohorts = byMetric.get(metricId);
    if (cohorts === undefined) continue;
    const metric = registry.get(metricId);

    const segments: CohortSegment[] = [...cohorts.values()].map(({ rows }) => {
      const byWeek = new Map<string, { start: string; values: number[] }>();
      for (const row of rows) {
        const session = sessionsById.get(row.sessionId)!;
        const { key, start } = weekOf(session.updatedAt);
        const bucket = byWeek.get(key) ?? { start, values: [] };
        bucket.values.push(row.score);
        byWeek.set(key, bucket);
      }
      const first = rows[0]!;
      return {
        metricVersion: first.metricVersion,
        judgeModel: first.judgeModel,
        weeks: sortedWeekPoints(byWeek),
        n: rows.length,
      };
    });
    segments.sort((a, b) => {
      const aStart = a.weeks[0]?.weekStart ?? '';
      const bStart = b.weeks[0]?.weekStart ?? '';
      return aStart < bStart ? -1 : aStart > bStart ? 1 : a.metricVersion - b.metricVersion;
    });

    trends.push({
      metricId,
      metricName: metric?.name ?? metricId,
      target: (metric?.target ?? 'collab') as MetricTarget,
      cohorts: segments,
    });
  }
  return trends;
}
