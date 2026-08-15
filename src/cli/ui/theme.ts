/**
 * Shared visual vocabulary for the Ink components: score coloring, target
 * tags, finding-status badges, and the score bar glyphs. Replaces the old
 * hand-rolled ANSI helpers in `src/cli/colors.ts` — Ink's `<Text color>`
 * does the escaping (and disables color for non-TTY streams).
 */

import type { FindingStatus, MetricTarget } from '../../metrics/index.js';

export type InkColor = 'red' | 'yellow' | 'green' | 'cyan' | 'magenta' | 'blue' | 'gray';

/** Red below 0.5, yellow below 0.75, green otherwise. */
export function scoreColor(score: number): InkColor {
  if (score < 0.5) return 'red';
  if (score < 0.75) return 'yellow';
  return 'green';
}

export function targetColor(target: MetricTarget): InkColor {
  return target === 'user' ? 'cyan' : target === 'agent' ? 'magenta' : 'blue';
}

export const BAR_WIDTH = 20;

/** `████████████░░░░░░░░` (color it with `scoreColor`). */
export function scoreBarText(score: number, width: number = BAR_WIDTH): string {
  const clamped = Math.min(1, Math.max(0, score));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export interface SparklineOptions {
  /** Glyph for weeks with no data. Default `·`. */
  gap?: string;
  /**
   * Fixed value range for the glyph heights. Without it a series is scaled
   * to its own min..max, which turns a 0.82→0.80 wiggle into a cliff —
   * always anchor bounded series (e.g. scores to {min: 0, max: 1}).
   */
  domain?: { min: number; max: number };
}

/** Glyph height for `value` within [min, max]; out-of-range values clamp. */
export function sparkGlyph(value: number, min: number, max: number): string {
  if (max <= min) return '▄';
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return SPARK_GLYPHS[Math.min(SPARK_GLYPHS.length - 1, Math.floor(ratio * SPARK_GLYPHS.length))]!;
}

/**
 * Unicode sparkline; `null` entries (weeks with no data) render as the gap
 * glyph. Scaled over `options.domain` when given, else the series' own
 * min..max (a flat self-scaled series renders mid-height).
 */
export function sparkline(
  values: readonly (number | null)[],
  options: SparklineOptions = {},
): string {
  const gap = options.gap ?? '·';
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return gap.repeat(values.length);
  const min = options.domain?.min ?? Math.min(...present);
  const max = options.domain?.max ?? Math.max(...present);
  return values.map((value) => (value === null ? gap : sparkGlyph(value, min, max))).join('');
}

/** Verdict badge per finding status: glyph + color, worded with the judge's own verdict. */
export const STATUS_BADGES: Record<FindingStatus, { glyph: string; color: InkColor }> = {
  satisfied: { glyph: '✓', color: 'green' },
  respected: { glyph: '✓', color: 'green' },
  used: { glyph: '✓', color: 'green' },
  partial: { glyph: '◐', color: 'yellow' },
  unclear: { glyph: '◐', color: 'yellow' },
  unsatisfied: { glyph: '✗', color: 'red' },
  violated: { glyph: '✗', color: 'red' },
  missed: { glyph: '✗', color: 'red' },
  issue: { glyph: '!', color: 'yellow' },
};
