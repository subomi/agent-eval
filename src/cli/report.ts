/**
 * Terminal report rendering: per-metric score bars with turn-cited evidence
 * and advice, followed by an overall summary with the top advice across
 * metrics. Designed to stay readable at ~80 columns.
 */

import type { Finding, FindingStatus } from '../metrics/index.js';
import type { RunMetricRecord, RunRecord } from '../store/runs.js';
import { bold, blue, cyan, dim, gray, green, magenta, red, scoreStyle, yellow } from './colors.js';
import { wrapHanging, wrapText } from './format.js';

const WIDTH = 80;
const BAR_WIDTH = 20;

/** Verdict badge per finding status: glyph + color, worded with the judge's own verdict. */
const STATUS_BADGES: Record<FindingStatus, { glyph: string; paint: (text: string) => string }> = {
  satisfied: { glyph: '✓', paint: green },
  respected: { glyph: '✓', paint: green },
  partial: { glyph: '◐', paint: yellow },
  unclear: { glyph: '◐', paint: yellow },
  unsatisfied: { glyph: '✗', paint: red },
  violated: { glyph: '✗', paint: red },
  issue: { glyph: '!', paint: yellow },
};

/** `████████████░░░░░░░░` colored red/yellow/green by score. */
export function scoreBar(score: number, width: number = BAR_WIDTH): string {
  const clamped = Math.min(1, Math.max(0, score));
  const filled = Math.round(clamped * width);
  return scoreStyle(clamped)('█'.repeat(filled) + '░'.repeat(width - filled));
}

function targetTag(target: RunMetricRecord['target']): string {
  const label = `[${target}]`;
  const paint = target === 'user' ? cyan : target === 'agent' ? magenta : blue;
  return paint(label);
}

function formatScore(score: number): string {
  return scoreStyle(score)(score.toFixed(2));
}

/**
 * Render one finding:
 *
 *     turn  43  ✗ violated   Subject of the judgement, bold, wrapped
 *               explanation in dim text, wrapped and indented underneath
 *
 * Findings without a status render as a plain wrapped note after the turn
 * gutter (legacy shape / fallback notes).
 */
function renderFinding(lines: string[], finding: Finding, statusWidth: number): void {
  const turnLabel = `turn ${String(finding.turnRef).padStart(3)}`;
  const gutter = `    ${gray(turnLabel)}  `;
  const indent = ' '.repeat(4 + turnLabel.length + 2);
  const bodyWidth = WIDTH - indent.length;

  if (finding.status === undefined) {
    const wrapped = wrapText(finding.note, bodyWidth);
    lines.push(`${gutter}${wrapped[0] ?? ''}`);
    for (const cont of wrapped.slice(1)) lines.push(`${indent}${cont}`);
    return;
  }

  const badge = STATUS_BADGES[finding.status];
  const badgeText = badge.paint(`${badge.glyph} ${finding.status.padEnd(statusWidth)}`);
  const badgeCols = 2 + statusWidth + 2; // "✗ " + padded verdict + 2-space gap

  // Subject line(s): the judged label when present, otherwise the note itself.
  const subject = finding.label ?? finding.note;
  const paintSubject = finding.label !== undefined ? bold : (text: string): string => text;
  const subjectLines = wrapHanging(subject, bodyWidth - badgeCols, bodyWidth);
  lines.push(`${gutter}${badgeText}  ${paintSubject(subjectLines[0] ?? '')}`);
  for (const cont of subjectLines.slice(1)) lines.push(`${indent}${paintSubject(cont)}`);

  // Explanation underneath, slightly deeper and dim, when the subject was a label.
  if (finding.label !== undefined) {
    for (const noteLine of wrapText(finding.note, bodyWidth - 2)) {
      lines.push(`${indent}  ${dim(noteLine)}`);
    }
  }
}

/**
 * Pick the most actionable advice across metrics: lowest-scoring metrics have
 * the most room to improve, so their advice ranks first (round-robin across
 * metrics, deduplicated).
 */
export function topAdvice(
  metrics: readonly RunMetricRecord[],
  count = 3,
): { metricName: string; advice: string }[] {
  const ranked = [...metrics]
    .filter((m) => m.advice.length > 0)
    .sort((a, b) => a.score - b.score);

  const picked: { metricName: string; advice: string }[] = [];
  const seen = new Set<string>();
  for (let round = 0; picked.length < count; round += 1) {
    let any = false;
    for (const metric of ranked) {
      const advice = metric.advice[round];
      if (advice === undefined) continue;
      any = true;
      const key = advice.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ metricName: metric.name, advice });
      if (picked.length >= count) break;
    }
    if (!any) break;
  }
  return picked;
}

export function renderReport(run: RunRecord): string {
  const lines: string[] = [];
  const stats = run.sessionStats;

  // Header
  lines.push(`${bold('Session')}  ${bold(run.title)}`);
  lines.push(
    `         ${dim(
      `${run.project} · ${run.agent} · ${stats.turnCount} turns ` +
        `(${stats.userTurnCount} user / ${stats.assistantTurnCount} assistant) · ` +
        `${stats.toolCallCount} tool calls`,
    )}`,
  );
  lines.push(`${bold('Judge')}    ${dim(`${run.model} · ${run.evaluatedAt}`)}`);
  lines.push('');

  const nameWidth = Math.max(...run.metrics.map((m) => m.name.length)) + 2;

  for (const metric of run.metrics) {
    // "[collab]" is the longest tag (8 chars); pad the plain text before coloring.
    const tagPad = ' '.repeat(8 - (metric.target.length + 2));
    lines.push(
      `${bold(metric.name.padEnd(nameWidth))}${targetTag(metric.target)}${tagPad}  ` +
        `${scoreBar(metric.score)}  ${formatScore(metric.score)}`,
    );

    // Pad every verdict word in this metric to the longest one, so subjects align.
    const statusWidth = Math.max(0, ...metric.findings.map((f) => f.status?.length ?? 0));
    for (const finding of metric.findings) {
      renderFinding(lines, finding, statusWidth);
    }

    if (metric.advice.length > 0) {
      if (metric.findings.length > 0) lines.push('');
      lines.push(`    ${dim('advice')}`);
      for (const advice of metric.advice) {
        const wrapped = wrapText(advice, WIDTH - 6);
        lines.push(`    ${cyan('•')} ${wrapped[0] ?? ''}`);
        for (const cont of wrapped.slice(1)) lines.push(`      ${cont}`);
      }
    }
    lines.push('');
  }

  // Overall summary
  lines.push(dim('─'.repeat(WIDTH)));
  lines.push(
    `${bold('Overall'.padEnd(nameWidth + 8))}  ${scoreBar(run.overallScore)}  ` +
      `${formatScore(run.overallScore)}  ${dim(`(average of ${run.metrics.length} metrics)`)}`,
  );

  const best = topAdvice(run.metrics);
  if (best.length > 0) {
    lines.push('');
    lines.push(bold('Top advice'));
    best.forEach(({ metricName, advice }, i) => {
      const lead = ` ${i + 1}. `;
      const wrapped = wrapText(`${dim(`[${metricName}]`)} ${advice}`, WIDTH - lead.length);
      lines.push(`${lead}${wrapped[0] ?? ''}`);
      for (const cont of wrapped.slice(1)) lines.push(`${' '.repeat(lead.length)}${cont}`);
    });
  }

  return lines.join('\n');
}
