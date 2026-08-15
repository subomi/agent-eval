/**
 * `agent-evals insights` computation entry point: loads rows from the DB,
 * applies the --since/--project filters, and assembles the full
 * `InsightsReport` (deterministic trends, judged trends with cohort breaks,
 * the Agent Leverage composite, repetition hotspots). Everything is derived
 * at read time; nothing aggregated is ever stored.
 *
 * The judge is resolved lazily and only for hotspot clustering — a DB with
 * no directives produces a complete report without any judge involvement.
 */

import { DIRECTIVE_EXTRACTOR_VERSION } from '../extract/directives.js';
import type { Judge } from '../judge/types.js';
import type { EvalsDb, SessionRow } from '../store/db.js';
import { computeComposite } from './composite.js';
import { computeHotspots } from './hotspots.js';
import { buildSummary } from './summary.js';
import { computeDeterministicTrends, computeJudgedTrends } from './trends.js';
import { INSIGHTS_SCHEMA_VERSION, type InsightsReport } from './types.js';
import { isoWeekKey } from './week.js';

export interface BuildInsightsOptions {
  db: EvalsDb;
  since?: Date | undefined;
  project?: string | undefined;
  /** Restrict to sessions from these agents; undefined = no filter. */
  agents?: readonly string[] | undefined;
  /** `[insights.weights]` from config.toml (may be empty). */
  weights: Readonly<Record<string, number>>;
  /**
   * Resolves the judge for hotspot clustering. Called at most once, and only
   * when there are directives to cluster; a resolution failure (e.g. no API
   * key) degrades the hotspots section instead of failing the report.
   */
  resolveJudge: () => Promise<{ judge: Judge; modelRef: string }>;
}

/** Returns null when no sessions match the filters (nothing to report on). */
export async function buildInsightsReport(
  options: BuildInsightsOptions,
): Promise<InsightsReport | null> {
  const { db } = options;

  const sessionFilter: { project?: string; sinceIso?: string; agents?: readonly string[] } = {};
  if (options.project !== undefined) sessionFilter.project = options.project;
  if (options.since !== undefined) sessionFilter.sinceIso = options.since.toISOString();
  if (options.agents !== undefined) sessionFilter.agents = options.agents;
  const sessions = db.listSessions(sessionFilter);
  if (sessions.length === 0) return null;

  const sessionsById = new Map<string, SessionRow>(sessions.map((s) => [s.sessionId, s]));
  const results = db.listMetricResults().filter((r) => sessionsById.has(r.sessionId));
  const directives = db
    .listDirectives({ extractorVersion: DIRECTIVE_EXTRACTOR_VERSION })
    .filter((d) => sessionsById.has(d.sessionId));

  const deterministicTrends = computeDeterministicTrends(sessions);
  const judgedTrends = computeJudgedTrends(results, sessionsById);
  const composite = computeComposite(results, sessionsById, options.weights);

  let judgeModel: string | null = null;
  let hotspots;
  if (directives.length === 0) {
    hotspots = await computeHotspots([], sessions.length, unusedJudge);
  } else {
    try {
      const resolved = await options.resolveJudge();
      judgeModel = resolved.modelRef;
      hotspots = await computeHotspots(directives, sessions.length, resolved.judge);
    } catch (error) {
      hotspots = {
        status: 'failed' as const,
        note: `no judge available for clustering: ${error instanceof Error ? error.message : String(error)}`,
        directiveCount: directives.length,
        sessionsWithDirectives: new Set(directives.map((d) => d.sessionId)).size,
        repetitionRate: null,
        clusters: [],
      };
    }
  }

  const evaluated = new Set(results.map((r) => r.sessionId)).size;
  const weeks = new Set(sessions.map((s) => isoWeekKey(new Date(s.updatedAt)))).size;
  const notes: string[] = [];
  if (sessions.length < 5) {
    notes.push(
      `only ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} in scope — read aggregates as anecdotes, not trends`,
    );
  }
  if (weeks < 2) {
    notes.push('all sessions fall in a single ISO week — trends need at least 2 weeks of history');
  }
  if (evaluated === 0) {
    notes.push('no metric results stored yet — judged sections are empty until `agent-evals batch` runs');
  }

  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    filters: {
      since: options.since?.toISOString() ?? null,
      project: options.project ?? null,
      agents: options.agents !== undefined ? [...options.agents] : null,
    },
    judgeModel,
    sessions: {
      count: sessions.length,
      evaluated,
      from: sessions[0]?.updatedAt ?? null,
      to: sessions.at(-1)?.updatedAt ?? null,
      weeks,
    },
    summary: buildSummary({ composite, deterministicTrends, hotspots, weeks }),
    notes,
    deterministicTrends,
    judgedTrends,
    composite,
    hotspots,
  };
}

/** Never called: computeHotspots returns before judging when the list is empty. */
const unusedJudge: Judge = {
  evaluate: () => Promise.reject(new Error('unreachable: no directives to cluster')),
};

export * from './types.js';
export { DEFAULT_WEIGHTS, FALLBACK_WEIGHT } from './composite.js';
export { compositeBand } from './summary.js';
