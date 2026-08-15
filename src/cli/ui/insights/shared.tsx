/**
 * Shared vocabulary for the insights views (interactive tabs and the static
 * artifact): number/date formatting, the calendar-true compressed sparkline,
 * trend arrows, and the report header. Everything here is a pure function of
 * report data plus an explicit character budget — the interactive app feeds
 * real terminal widths, the static artifact feeds the fixed 80-column budget.
 *
 * Sparkline discipline: the x-axis is true calendar weeks, but long empty
 * stretches compress to a `┄N┄` (N-week gap) marker instead of a wall of
 * dots. Heights are anchored — judged scores to the fixed 0–1 scale,
 * deterministic series from zero — so a tiny wiggle can never render as a
 * cliff. `┊` marks a cohort break.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { DeterministicTrend, InsightsReport, WeekPoint } from '../../../insights/index.js';
import { enumerateWeeks } from '../../../insights/week.js';
import { sparkGlyph, type InkColor } from '../theme.js';

/** The static artifact's fixed layout budget (the historical 80-col style). */
export const STATIC_WIDTH = 80;
/** Interactive views cap here even on very wide terminals. */
export const MAX_WIDTH = 120;
/** Empty-week runs longer than this compress to a `┄N┄` marker. */
const SHORT_GAP_MAX = 3;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function pct1(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatValue(value: number, unit: 'ratio' | 'count'): string {
  return unit === 'ratio' ? pct1(value) : value.toFixed(1);
}

export function formatDelta(delta: number, unit: 'ratio' | 'count'): string {
  const sign = delta >= 0 ? '+' : '';
  return unit === 'ratio' ? `${sign}${(delta * 100).toFixed(1)}pp` : `${sign}${delta.toFixed(1)}`;
}

/** Percentile as 0..100 points for the composite table. */
export function points(value: number): string {
  return String(Math.round(value * 100));
}

export function signedPoints(value: number): string {
  const rounded = Math.round(value * 100);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

export function day(iso: string): string {
  return iso.slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthYear(isoDate: string): { month: string; year: number } {
  const date = new Date(isoDate);
  return { month: MONTHS[date.getUTCMonth()]!, year: date.getUTCFullYear() };
}

/** "Feb → Aug 2026" (same year) or "Nov 2025 → Aug 2026". */
export function timelineRange(firstIso: string, lastIso: string): string {
  const from = monthYear(firstIso);
  const to = monthYear(lastIso);
  if (from.year === to.year) {
    return from.month === to.month ? `${to.month} ${to.year}` : `${from.month} → ${to.month} ${to.year}`;
  }
  return `${from.month} ${from.year} → ${to.month} ${to.year}`;
}

// ---------------------------------------------------------------------------
// Sparkline building: calendar-true x-axis with compressed gaps
// ---------------------------------------------------------------------------

/**
 * Render a weekly series as a sparkline over true calendar weeks: short
 * gaps (≤3 empty weeks) render as `·` dots, longer runs compress to `┄N┄`.
 * Heights are scaled over `domain` when given (anchor bounded series!),
 * else zero → the series' own max. Truncates oldest-first when over budget,
 * prefixing `…`.
 */
export function compressedSpark(
  weeks: readonly WeekPoint[],
  options: { maxChars: number; domain?: { min: number; max: number } },
): string {
  if (weeks.length === 0) return '';
  const byStart = new Map(weeks.map((w) => [w.weekStart, w.value]));
  const grid = enumerateWeeks(new Date(weeks[0]!.weekStart), new Date(weeks.at(-1)!.weekStart)).map(
    (start) => byStart.get(start.toISOString().slice(0, 10)) ?? null,
  );

  const present = grid.filter((v): v is number => v !== null);
  const min = options.domain?.min ?? 0;
  const max = options.domain?.max ?? Math.max(...present);

  const chunks: string[] = [];
  let gapRun = 0;
  const flushGap = (): void => {
    if (gapRun === 0) return;
    chunks.push(gapRun <= SHORT_GAP_MAX ? '·'.repeat(gapRun) : `┄${gapRun}┄`);
    gapRun = 0;
  };
  for (const value of grid) {
    if (value === null) {
      gapRun += 1;
    } else {
      flushGap();
      chunks.push(sparkGlyph(value, min, max));
    }
  }
  flushGap();

  // Keep the most recent chunks that fit the budget.
  const keepWithin = (budget: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const length = chunks[i]!.length;
      if (used + length > budget) break;
      kept.unshift(chunks[i]!);
      used += length;
    }
    return kept;
  };
  let kept = keepWithin(options.maxChars);
  if (kept.length < chunks.length) kept = ['…', ...keepWithin(options.maxChars - 1)];
  return kept.join('');
}

// ---------------------------------------------------------------------------
// Trend arrows
// ---------------------------------------------------------------------------

export interface TrendArrow {
  text: string;
  word: string;
  color: InkColor;
}

export function arrowFor(trend: DeterministicTrend): TrendArrow {
  if (trend.direction === null || trend.latest === null || trend.previous === null) {
    return { text: '', word: '', color: 'gray' };
  }
  // The arrow carries the sign, so the delta is shown as a magnitude.
  const delta = formatDelta(Math.abs(trend.latest - trend.previous), trend.unit).replace('+', '');
  if (trend.direction === 'flat') return { text: `→ ${delta}`, word: 'steady', color: 'gray' };
  const improved = trend.direction === 'down' ? trend.lowerIsBetter : !trend.lowerIsBetter;
  return {
    text: `${trend.direction === 'up' ? '↑' : '↓'} ${delta}`,
    word: improved ? 'better' : 'worse',
    color: improved ? 'green' : 'red',
  };
}

// ---------------------------------------------------------------------------
// Small layout components
// ---------------------------------------------------------------------------

export function SectionTitle({ title, subtitle }: { title: string; subtitle: string }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{`   ${subtitle}`}</Text>
    </Box>
  );
}

export function NoteLine({ note }: { note: string }): ReactElement {
  return (
    <Box marginLeft={2}>
      <Text dimColor>{`note: ${note}`}</Text>
    </Box>
  );
}

/** Header: session count, date range, week count, and any active filters. */
export function ReportHeader({ report }: { report: InsightsReport }): ReactElement {
  const s = report.sessions;
  const range = s.from !== null && s.to !== null ? `${day(s.from)} → ${day(s.to)}` : '';
  const filters: string[] = [];
  if (report.filters.project !== null) filters.push(`project=${report.filters.project}`);
  if (report.filters.since !== null) filters.push(`since=${day(report.filters.since)}`);
  if (report.filters.agents !== null) filters.push(`agents=${report.filters.agents.join(',')}`);

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Insights</Text>
        <Text dimColor>
          {`   ${s.count} ${s.count === 1 ? 'session' : 'sessions'} (${s.evaluated} judged) · ${range} · ` +
            `${s.weeks} ISO ${s.weeks === 1 ? 'week' : 'weeks'}`}
        </Text>
      </Text>
      {filters.length > 0 && (
        <Box marginLeft={11}>
          <Text dimColor>{`filters: ${filters.join(' · ')}`}</Text>
        </Box>
      )}
    </Box>
  );
}
