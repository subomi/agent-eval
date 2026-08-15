/**
 * Agent Leverage composite.
 *
 * Raw judge scores are not comparable across metrics (each has its own
 * scale habits), so each session's score for a metric is first converted to
 * a percentile against the user's OWN full history of scores for that same
 * metric (mid-rank: ties share their average rank, values map into 0..1,
 * a lone score maps to 0.5). A session's composite is then the weighted
 * mean of its metric percentiles, with weights from `[insights.weights]`
 * in config.toml falling back to the defaults below.
 *
 * The headline is the mean session composite over the most recent 4 weeks
 * of activity — anchored at the NEWEST SESSION, not at "now", so a pause in
 * usage doesn't empty the window — and the 4-week delta compares it against
 * the preceding 4 weeks. Because percentiles are ranked against full
 * history, a headline above 0.5 means recent sessions beat your typical
 * historical session. The formula lives only here and in config, so it can
 * change freely without touching stored data.
 */

import { allMetrics, type MetricTarget } from '../metrics/index.js';
import type { MetricResultRow, SessionRow } from '../store/db.js';
import type { CompositeComponent, CompositeReport, CompositeWindow } from './types.js';

/**
 * Default composite weights per metric id. Outcome (goal completion) leads;
 * execution quality (adherence, tools, conversation) carries the middle;
 * user-side craft (prompting, steering) and skill usage round it out.
 * Metrics absent here (e.g. future ones) fall back to `FALLBACK_WEIGHT`.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = {
  'goal-completion': 0.25,
  'instruction-adherence': 0.15,
  'tool-efficiency': 0.15,
  'conversation-efficiency': 0.15,
  'prompt-quality': 0.1,
  'steering-grounding': 0.1,
  'skill-utilization': 0.1,
};

export const FALLBACK_WEIGHT = 0.1;

const WINDOW_WEEKS = 4;
const WINDOW_MS = WINDOW_WEEKS * 7 * 86_400_000;
const THIN_HISTORY_SESSIONS = 8;

export interface EffectiveWeight {
  weight: number;
  source: 'config' | 'default';
}

export function effectiveWeight(
  metricId: string,
  configWeights: Readonly<Record<string, number>>,
): EffectiveWeight {
  const configured = configWeights[metricId];
  if (configured !== undefined && configured >= 0) {
    return { weight: configured, source: 'config' };
  }
  return { weight: DEFAULT_WEIGHTS[metricId] ?? FALLBACK_WEIGHT, source: 'default' };
}

/** Mid-rank percentile of `value` within `history` (which includes it). */
export function percentileRank(value: number, history: readonly number[]): number {
  let less = 0;
  let equal = 0;
  for (const other of history) {
    if (other < value) less += 1;
    else if (other === value) equal += 1;
  }
  return (less + equal / 2) / history.length;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Latest score per (session, metric), across all cohorts. */
function latestPerSessionMetric(results: readonly MetricResultRow[]): Map<string, MetricResultRow> {
  const latest = new Map<string, MetricResultRow>();
  for (const row of results) {
    const key = `${row.sessionId}\u0000${row.metricId}`;
    const existing = latest.get(key);
    if (existing === undefined || existing.evaluatedAt < row.evaluatedAt) latest.set(key, row);
  }
  return latest;
}

export function computeComposite(
  results: readonly MetricResultRow[],
  sessionsById: ReadonlyMap<string, SessionRow>,
  configWeights: Readonly<Record<string, number>>,
): CompositeReport {
  const registry = new Map(allMetrics.map((m) => [m.id, m]));
  const inScope = [...latestPerSessionMetric(results).values()].filter((row) =>
    sessionsById.has(row.sessionId),
  );

  // Percentile-normalize each score against the metric's full history.
  const historyByMetric = new Map<string, number[]>();
  for (const row of inScope) {
    const history = historyByMetric.get(row.metricId) ?? [];
    history.push(row.score);
    historyByMetric.set(row.metricId, history);
  }
  // session -> metric -> percentile
  const percentiles = new Map<string, Map<string, number>>();
  for (const row of inScope) {
    const perSession = percentiles.get(row.sessionId) ?? new Map<string, number>();
    perSession.set(row.metricId, percentileRank(row.score, historyByMetric.get(row.metricId)!));
    percentiles.set(row.sessionId, perSession);
  }

  const metricIds = [
    ...allMetrics.map((m) => m.id),
    ...[...historyByMetric.keys()].filter((id) => !registry.has(id)).sort(),
  ];
  const weights = new Map(metricIds.map((id) => [id, effectiveWeight(id, configWeights)]));

  // Split scored sessions into the two 4-week windows, anchored at the
  // newest scored session.
  const scored = [...percentiles.keys()]
    .map((id) => sessionsById.get(id)!)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  const historySessions = scored.length;

  const emptyReport = (note: string): CompositeReport => ({
    headline: null,
    delta4w: null,
    windowWeeks: WINDOW_WEEKS,
    recentWindow: null,
    previousWindow: null,
    historySessions,
    components: [],
    note,
  });
  if (historySessions === 0) {
    return emptyReport('no judged sessions yet — run `agent-evals batch` first');
  }

  const anchor = new Date(scored.at(-1)!.updatedAt).getTime();
  const recentStart = anchor - WINDOW_MS;
  const previousStart = anchor - 2 * WINDOW_MS;
  const inWindow = (s: SessionRow, startMs: number, endMs: number): boolean => {
    const t = new Date(s.updatedAt).getTime();
    return t > startMs && t <= endMs;
  };
  const recent = scored.filter((s) => inWindow(s, recentStart, anchor));
  const previous = scored.filter((s) => inWindow(s, previousStart, recentStart));

  const windowInfo = (sessions: SessionRow[], startMs: number, endMs: number): CompositeWindow => ({
    start: new Date(startMs + 1).toISOString(),
    end: new Date(endMs).toISOString(),
    sessions: sessions.length,
  });

  // Session composite = Σ w·p / Σ w over the metrics present in the session;
  // a metric's contribution is its share of that, so contributions sum to
  // the headline exactly.
  const sessionComposite = (session: SessionRow): { total: number; byMetric: Map<string, number> } => {
    const perSession = percentiles.get(session.sessionId)!;
    let weightSum = 0;
    for (const metricId of perSession.keys()) weightSum += weights.get(metricId)?.weight ?? FALLBACK_WEIGHT;
    const byMetric = new Map<string, number>();
    let total = 0;
    if (weightSum <= 0) return { total: 0, byMetric };
    for (const [metricId, pctl] of perSession) {
      const share = ((weights.get(metricId)?.weight ?? FALLBACK_WEIGHT) * pctl) / weightSum;
      byMetric.set(metricId, share);
      total += share;
    }
    return { total, byMetric };
  };

  const windowStats = (
    sessions: readonly SessionRow[],
  ): {
    headline: number | null;
    contributions: Map<string, number>;
    meanPctl: Map<string, number>;
    countByMetric: Map<string, number>;
  } => {
    const contributions = new Map<string, number>();
    const pctlSums = new Map<string, number>();
    const countByMetric = new Map<string, number>();
    if (sessions.length === 0) {
      return { headline: null, contributions, meanPctl: new Map(), countByMetric };
    }
    const totals: number[] = [];
    for (const session of sessions) {
      const { total, byMetric } = sessionComposite(session);
      totals.push(total);
      for (const [metricId, share] of byMetric) {
        contributions.set(metricId, (contributions.get(metricId) ?? 0) + share / sessions.length);
      }
      for (const [metricId, pctl] of percentiles.get(session.sessionId)!) {
        pctlSums.set(metricId, (pctlSums.get(metricId) ?? 0) + pctl);
        countByMetric.set(metricId, (countByMetric.get(metricId) ?? 0) + 1);
      }
    }
    const meanPctl = new Map<string, number>();
    for (const [metricId, sum] of pctlSums) meanPctl.set(metricId, sum / countByMetric.get(metricId)!);
    return { headline: mean(totals), contributions, meanPctl, countByMetric };
  };

  const recentStats = windowStats(recent);
  const previousStats = windowStats(previous);

  const components: CompositeComponent[] = metricIds
    .filter((id) => historyByMetric.has(id) || registry.has(id))
    .map((metricId) => {
      const metric = registry.get(metricId);
      const { weight, source } = weights.get(metricId)!;
      const recentPctl = recentStats.meanPctl.get(metricId) ?? null;
      const prevPctl = previousStats.meanPctl.get(metricId) ?? null;
      return {
        metricId,
        metricName: metric?.name ?? metricId,
        target: (metric?.target ?? 'collab') as MetricTarget,
        weight,
        weightSource: source,
        recentSessions: recentStats.countByMetric.get(metricId) ?? 0,
        meanPercentile: recentPctl,
        previousMeanPercentile: prevPctl,
        delta: recentPctl !== null && prevPctl !== null ? recentPctl - prevPctl : null,
        contribution: recentStats.contributions.get(metricId) ?? (recent.length > 0 ? 0 : null),
      };
    });

  const notes: string[] = [];
  if (historySessions < THIN_HISTORY_SESSIONS) {
    notes.push(
      `percentiles are ranked against only ${historySessions} judged ` +
        `${historySessions === 1 ? 'session' : 'sessions'} of history — treat with caution`,
    );
  }
  if (previous.length === 0) {
    notes.push('no sessions in the prior 4-week window, so no delta');
  }

  return {
    headline: recentStats.headline,
    delta4w:
      recentStats.headline !== null && previousStats.headline !== null
        ? recentStats.headline - previousStats.headline
        : null,
    windowWeeks: WINDOW_WEEKS,
    recentWindow: windowInfo(recent, recentStart, anchor),
    previousWindow: previous.length > 0 ? windowInfo(previous, previousStart, recentStart) : null,
    historySessions,
    components,
    note: notes.length > 0 ? notes.join('; ') : null,
  };
}
