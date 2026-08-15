/**
 * The insights report structure: everything `agent-evals insights` computes,
 * shared by the Ink view and the `--json` output. Nothing here is persisted —
 * the whole report is derived at read time from the DB.
 */

import type { MetricTarget } from '../metrics/index.js';
import type { DirectiveRow } from '../store/db.js';

/** v2: adds `summary` (plain-language verdict lines) to the report. */
export const INSIGHTS_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Weekly series
// ---------------------------------------------------------------------------

export interface WeekPoint {
  /** ISO week key, e.g. "2026-W33". */
  week: string;
  /** ISO date of the week's Monday (UTC). */
  weekStart: string;
  value: number;
  /** Sample size behind the value (sessions or metric results). */
  n: number;
}

// ---------------------------------------------------------------------------
// Section 1: deterministic trends
// ---------------------------------------------------------------------------

export type DeterministicTrendId =
  | 'steering-rate'
  | 'turns-per-session'
  | 'tool-failure-rate'
  | 'repeated-tool-call-rate';

export interface DeterministicTrend {
  id: DeterministicTrendId;
  label: string;
  /** "ratio" renders as a percentage, "count" as a plain number. */
  unit: 'ratio' | 'count';
  /** Only weeks that contain sessions; gaps carry no point. */
  weeks: WeekPoint[];
  latest: number | null;
  /** The value of the most recent week before the latest one. */
  previous: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  /** Whether a falling value is an improvement (arrow coloring). */
  lowerIsBetter: boolean;
}

// ---------------------------------------------------------------------------
// Section 2: judged trends with cohort breaks
// ---------------------------------------------------------------------------

/**
 * A cohort is one (metric_version, judge_model) pair. Scores are never
 * averaged across cohorts: each renders as its own weekly-median series,
 * with a visible break between cohorts.
 */
export interface CohortSegment {
  metricVersion: number;
  judgeModel: string;
  /** Weekly median scores (0..1), bucketed by session activity week. */
  weeks: WeekPoint[];
  /** Total metric results in this cohort. */
  n: number;
}

export interface JudgedMetricTrend {
  metricId: string;
  metricName: string;
  target: MetricTarget;
  /** Chronological by first activity; >1 segment means a cohort break. */
  cohorts: CohortSegment[];
}

// ---------------------------------------------------------------------------
// Section 3: Agent Leverage composite
// ---------------------------------------------------------------------------

export interface CompositeComponent {
  metricId: string;
  metricName: string;
  target: MetricTarget;
  weight: number;
  weightSource: 'config' | 'default';
  /** Sessions in the recent window with a score for this metric. */
  recentSessions: number;
  /** Mean percentile (0..1) across recent-window sessions; null when none. */
  meanPercentile: number | null;
  /** Same over the previous window. */
  previousMeanPercentile: number | null;
  delta: number | null;
  /** This metric's share of the headline; components sum to the headline. */
  contribution: number | null;
}

export interface CompositeWindow {
  /** ISO instants; the recent window is anchored at the newest session. */
  start: string;
  end: string;
  sessions: number;
}

export interface CompositeReport {
  /** Weighted mean percentile (0..1) over recent-window sessions. */
  headline: number | null;
  /** Headline minus the previous window's headline. */
  delta4w: number | null;
  windowWeeks: number;
  recentWindow: CompositeWindow | null;
  previousWindow: CompositeWindow | null;
  /** Sessions forming the normalization history (any metric result). */
  historySessions: number;
  components: CompositeComponent[];
  note: string | null;
}

// ---------------------------------------------------------------------------
// Section 4: repetition hotspots
// ---------------------------------------------------------------------------

export type ArtifactKind = 'cursor-rule' | 'agents-md' | 'skill' | 'prompt-template';

export interface HotspotCluster {
  theme: string;
  /** Distinct sessions contributing at least one member directive. */
  sessionCount: number;
  directiveCount: number;
  /** True when the theme spans two or more sessions. */
  repeated: boolean;
  kinds: DirectiveRow['kind'][];
  /** Up to two member directive texts, verbatim. */
  examples: string[];
  artifact: ArtifactKind;
  /** Short ready-to-use draft for the suggested artifact. */
  draft: string;
}

export interface HotspotsReport {
  status: 'ok' | 'no-directives' | 'failed';
  note: string | null;
  directiveCount: number;
  sessionsWithDirectives: number;
  /** Share of in-scope sessions containing a repeated theme; null when n/a. */
  repetitionRate: number | null;
  clusters: HotspotCluster[];
}

// ---------------------------------------------------------------------------
// The full report
// ---------------------------------------------------------------------------

export interface InsightsReport {
  schemaVersion: number;
  generatedAt: string;
  filters: { since: string | null; project: string | null; agents: string[] | null };
  /** Judge model used for hotspot clustering; null when none was needed. */
  judgeModel: string | null;
  sessions: {
    count: number;
    evaluated: number;
    from: string | null;
    to: string | null;
    weeks: number;
  };
  /**
   * The report's lead: 1-3 plain-language sentences answering "am I getting
   * better?", synthesized deterministically from the sections below.
   */
  summary: string[];
  /** Thin-data caveats that apply to the report as a whole. */
  notes: string[];
  deterministicTrends: DeterministicTrend[];
  judgedTrends: JudgedMetricTrend[];
  composite: CompositeReport;
  hotspots: HotspotsReport;
}
