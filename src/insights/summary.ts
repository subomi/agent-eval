/**
 * The report's lead paragraph: 1-3 plain-language sentences answering "am I
 * getting better?", synthesized deterministically from the already-computed
 * sections (no judge involvement). Shared by the Ink view (rendered at the
 * top) and `--json` (the `summary` field).
 */

import type { CompositeReport, DeterministicTrend, HotspotsReport } from './types.js';

/** Plain-words band for a composite headline (0..1 percentile). */
export function compositeBand(headline: number): string {
  if (headline >= 0.55) return 'above your historical norm';
  if (headline <= 0.45) return 'below your historical norm';
  return 'about typical for your history';
}

function pts(value: number): number {
  return Math.round(value * 100);
}

/** "9.6pp" / "12.5 turns" style delta magnitude for a deterministic trend. */
function deltaMagnitude(trend: DeterministicTrend): string {
  if (trend.latest === null || trend.previous === null) return '';
  const delta = Math.abs(trend.latest - trend.previous);
  return trend.unit === 'ratio' ? `${(delta * 100).toFixed(1)}pp` : delta.toFixed(1);
}

export function buildSummary(input: {
  composite: CompositeReport;
  deterministicTrends: readonly DeterministicTrend[];
  hotspots: HotspotsReport;
  weeks: number;
}): string[] {
  const lines: string[] = [];

  // 1. The composite verdict.
  const { composite } = input;
  if (composite.headline === null) {
    lines.push('No judged history yet, so no overall verdict — run `agent-evals batch` first.');
  } else {
    const delta =
      composite.delta4w === null
        ? ''
        : composite.delta4w === 0
          ? ', unchanged from the prior window'
          : `, ${composite.delta4w > 0 ? 'up' : 'down'} ${Math.abs(pts(composite.delta4w))} points from the prior window`;
    lines.push(
      `Your recent sessions score ${pts(composite.headline)}/100 — ` +
        `${compositeBand(composite.headline)}${delta}.`,
    );
  }

  // 2. Week-over-week movement in the judge-free signals.
  if (input.weeks >= 2) {
    const moved = input.deterministicTrends.filter(
      (t) => t.direction === 'up' || t.direction === 'down',
    );
    const improving = moved.filter((t) => (t.direction === 'down') === t.lowerIsBetter);
    const worsening = moved.filter((t) => (t.direction === 'down') !== t.lowerIsBetter);
    const phrase = (trends: DeterministicTrend[]): string =>
      trends.map((t) => `${t.label} (${deltaMagnitude(t)})`).join(', ');
    if (improving.length > 0 || worsening.length > 0) {
      const parts: string[] = [];
      if (improving.length > 0) parts.push(`improving on ${phrase(improving)}`);
      if (worsening.length > 0) parts.push(`worsening on ${phrase(worsening)}`);
      lines.push(`Week over week you are ${parts.join(', but ')}.`);
    } else if (input.deterministicTrends.some((t) => t.direction === 'flat')) {
      lines.push('The judge-free signals are steady week over week.');
    }
  }

  // 3. Repetition: the most actionable takeaway when present.
  const { hotspots } = input;
  if (hotspots.status === 'ok' && hotspots.repetitionRate !== null && hotspots.repetitionRate > 0) {
    lines.push(
      `You repeat the same guidance in ${(hotspots.repetitionRate * 100).toFixed(1)}% of sessions — ` +
        'the hotspots section suggests rules/skills to capture it once.',
    );
  }

  return lines;
}
