/**
 * The four insights sections, split out of the old monolithic artifact and
 * parameterized by a character-width budget. `width: 80` reproduces the
 * historical static layout exactly; the interactive tabs feed real terminal
 * widths so sparklines and tables can breathe.
 *
 * Every component here is a pure function of report data (plus the width),
 * which is what lets a later phase swap a tab's body for a judge-composed
 * spec renderer without touching the interactive shell.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type {
  CompositeReport,
  DeterministicTrend,
  HotspotsReport,
  JudgedMetricTrend,
} from '../../../insights/index.js';
import { compositeBand } from '../../../insights/index.js';
import { singleLine } from '../../format.js';
import { scoreBarText, scoreColor, targetColor } from '../theme.js';
import {
  arrowFor,
  compressedSpark,
  day,
  formatValue,
  NoteLine,
  pct1,
  points,
  SectionTitle,
  signedPoints,
  timelineRange,
} from './shared.js';

const COHORT_BREAK = ' ┊ ';

// ---------------------------------------------------------------------------
// Section 1: deterministic trends
// ---------------------------------------------------------------------------

export function DeterministicSection({
  trends,
  width,
}: {
  trends: readonly DeterministicTrend[];
  width: number;
}): ReactElement {
  // 26 chars at the historical 80-col budget; extra width goes to the spark.
  const sparkBudget = Math.min(60, Math.max(26, width - 54));
  const thin = trends.every((t) => t.weeks.length < 2);
  const anyWeeks = trends[0]?.weeks ?? [];
  return (
    <Box flexDirection="column">
      <SectionTitle title="Deterministic trends" subtitle="weekly · from session stats · no judge" />
      {thin ? (
        <NoteLine note="fewer than 2 weeks of data — showing current values, not trends" />
      ) : null}
      {trends.map((trend) => {
        const spark = compressedSpark(trend.weeks, { maxChars: sparkBudget });
        const arrow = arrowFor(trend);
        return (
          <Box key={trend.id} marginLeft={2}>
            <Box width={25} flexShrink={0}>
              <Text>{trend.label}</Text>
            </Box>
            <Box width={sparkBudget + 2} flexShrink={0}>
              <Text color="cyan">{spark}</Text>
            </Box>
            <Box width={8} flexShrink={0} justifyContent="flex-end">
              <Text bold>{trend.latest === null ? '—' : formatValue(trend.latest, trend.unit)}</Text>
            </Box>
            <Box marginLeft={2}>
              {arrow.text.length > 0 ? (
                <Text>
                  <Text color={arrow.color}>{arrow.text}</Text>
                  <Text dimColor>{` ${arrow.word}`}</Text>
                </Text>
              ) : (
                <Text dimColor>{trend.weeks.length === 1 ? '(1 week)' : ''}</Text>
              )}
            </Box>
          </Box>
        );
      })}
      {anyWeeks.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>
            {`timeline ${timelineRange(anyWeeks[0]!.weekStart, anyWeeks.at(-1)!.weekStart)}` +
              ', ┄N┄ or · = empty weeks, heights scale from 0'}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Section 2: judged trends with cohort breaks
// ---------------------------------------------------------------------------

export function JudgedSection({
  trends,
  width,
}: {
  trends: readonly JudgedMetricTrend[];
  width: number;
}): ReactElement {
  // 24 chars at the historical 80-col budget, shared across cohorts.
  const sparkBudget = Math.min(60, Math.max(24, width - 56));
  const anyBreaks = trends.some((t) => t.cohorts.length > 1);
  const judgeModels = [
    ...new Set(trends.flatMap((t) => t.cohorts.map((c) => c.judgeModel))),
  ];
  const byTarget = ['user', 'agent', 'collab'] as const;
  const ordered = byTarget.flatMap((target) => trends.filter((t) => t.target === target));
  const allWeeks = trends
    .flatMap((t) => t.cohorts.flatMap((c) => c.weeks))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));

  return (
    <Box flexDirection="column">
      <SectionTitle title="Judged trends" subtitle="weekly median score 0–1 · never averaged across cohorts" />
      {ordered.length === 0 ? (
        <NoteLine note="no metric results yet — run `agent-evals batch`" />
      ) : (
        <>
          {ordered.map((trend) => {
            const perCohortBudget = Math.max(
              4,
              Math.floor(
                (sparkBudget - COHORT_BREAK.length * (trend.cohorts.length - 1)) /
                  trend.cohorts.length,
              ),
            );
            const spark = trend.cohorts
              .map((c) =>
                compressedSpark(c.weeks, {
                  maxChars: perCohortBudget,
                  domain: { min: 0, max: 1 },
                }),
              )
              .join(COHORT_BREAK);
            const latest = trend.cohorts.at(-1)?.weeks.at(-1)?.value;
            const n = trend.cohorts.reduce((sum, c) => sum + c.n, 0);
            return (
              <Box key={trend.metricId} flexDirection="column">
                <Box marginLeft={2}>
                  <Box width={9} flexShrink={0}>
                    <Text color={targetColor(trend.target)}>{`[${trend.target}]`}</Text>
                  </Box>
                  <Box width={25} flexShrink={0}>
                    <Text>{trend.metricName}</Text>
                  </Box>
                  <Box width={sparkBudget} flexShrink={0}>
                    <Text color="cyan">{spark}</Text>
                  </Box>
                  {latest === undefined ? (
                    <Text dimColor>—</Text>
                  ) : (
                    <Text bold color={scoreColor(latest)}>
                      {latest.toFixed(2)}
                    </Text>
                  )}
                  <Text dimColor>{` · ${n} evals`}</Text>
                </Box>
                {trend.cohorts.length > 1 &&
                  trend.cohorts.map((cohort, i) => (
                    <Box key={i} marginLeft={11}>
                      <Text dimColor>
                        {`cohort ${i + 1}: v${cohort.metricVersion} · ${cohort.judgeModel} (${cohort.n} evals)`}
                      </Text>
                    </Box>
                  ))}
              </Box>
            );
          })}
          {allWeeks.length > 0 && (
            <Box marginLeft={2}>
              <Text dimColor>
                {`timeline ${timelineRange(allWeeks[0]!.weekStart, allWeeks.at(-1)!.weekStart)}` +
                  ', ┄N┄ or · = empty weeks, heights = score 0–1'}
              </Text>
            </Box>
          )}
          <Box marginLeft={2}>
            <Text dimColor>
              {anyBreaks
                ? '┊ marks a cohort break (metric version or judge model changed)'
                : `single cohort per metric · judge ${judgeModels.join(', ')}`}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Section 3: Agent Leverage composite
// ---------------------------------------------------------------------------

const BAR = 12;

export function CompositeSection({
  composite,
  width,
}: {
  composite: CompositeReport;
  width: number;
}): ReactElement {
  // 24-char metric column at the historical 80-col budget; extra width
  // loosens the name truncation.
  const nameWidth = Math.min(40, 24 + Math.max(0, width - 80));
  return (
    <Box flexDirection="column">
      <SectionTitle
        title="Agent Leverage"
        subtitle={`last ${composite.windowWeeks} weeks vs your full history · percentile-normalized`}
      />
      {composite.headline === null ? (
        <NoteLine note={composite.note ?? 'not enough data for the composite'} />
      ) : (
        <>
          <Box marginLeft={2}>
            <Text>
              <Text bold color={scoreColor(composite.headline)}>
                {`${points(composite.headline)} / 100`}
              </Text>
              <Text dimColor>{` — ${compositeBand(composite.headline)} (50 = your typical session)`}</Text>
            </Text>
          </Box>
          <Box marginLeft={2}>
            {composite.delta4w !== null ? (
              <Text color={composite.delta4w > 0 ? 'green' : composite.delta4w < 0 ? 'red' : 'gray'}>
                {`${signedPoints(composite.delta4w)} points vs the prior ${composite.windowWeeks}-week window`}
              </Text>
            ) : (
              <Text dimColor>no prior window to compare against yet</Text>
            )}
          </Box>
          <Box marginLeft={2}>
            <Text dimColor>
              {`recent ${composite.recentWindow?.sessions ?? 0} sessions ending ${day(
                composite.recentWindow?.end ?? '',
              )} · ${composite.historySessions} judged sessions in history`}
            </Text>
          </Box>
          <Box height={1} />
          <Box marginLeft={2}>
            <Text dimColor>
              {`${'METRIC'.padEnd(nameWidth)}${'TARGET'.padEnd(8)}${'PERCENTILE'.padEnd(17)}${'CHANGE'.padStart(7)}${'N'.padStart(4)}${'WEIGHT'.padStart(8)}${'CONTRIB'.padStart(9)}`}
            </Text>
          </Box>
          {composite.components.map((c) => (
            <Box key={c.metricId} marginLeft={2}>
              <Text>{singleLine(c.metricName, nameWidth - 1).padEnd(nameWidth)}</Text>
              <Text color={targetColor(c.target)}>{c.target.padEnd(8)}</Text>
              {c.meanPercentile === null ? (
                <Text dimColor>{'—'.padEnd(17)}</Text>
              ) : (
                <Text>
                  <Text color={scoreColor(c.meanPercentile)}>{scoreBarText(c.meanPercentile, BAR)}</Text>
                  <Text bold>{points(c.meanPercentile).padStart(4)}</Text>
                  <Text> </Text>
                </Text>
              )}
              {c.delta === null ? (
                <Text dimColor>{'—'.padStart(7)}</Text>
              ) : (
                <Text color={c.delta > 0 ? 'green' : c.delta < 0 ? 'red' : 'gray'}>
                  {signedPoints(c.delta).padStart(7)}
                </Text>
              )}
              <Text dimColor>{String(c.recentSessions).padStart(4)}</Text>
              <Text>{`${c.weight.toFixed(2)}${c.weightSource === 'config' ? '*' : ' '}`.padStart(8)}</Text>
              <Text>{(c.contribution === null ? '—' : points(c.contribution)).padStart(9)}</Text>
            </Box>
          ))}
          <Box marginLeft={2}>
            <Text dimColor>
              {'PERCENTILE: 50 = your typical session · CHANGE: recent minus prior window'}
            </Text>
          </Box>
          <Box marginLeft={2}>
            <Text dimColor>
              {'N: sessions scored · WEIGHT *: from config.toml · CONTRIB: sums to headline'}
            </Text>
          </Box>
          {composite.note !== null && <NoteLine note={composite.note} />}
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Section 4: repetition hotspots (compact dump — the static artifact's view;
// the interactive HotspotsTab renders master/detail instead)
// ---------------------------------------------------------------------------

export function HotspotsSection({
  hotspots,
  sessionCount,
}: {
  hotspots: HotspotsReport;
  sessionCount: number;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <SectionTitle title="Repetition hotspots" subtitle="directives clustered into themes · one judge call" />
      {hotspots.status !== 'ok' ? (
        <NoteLine note={hotspots.note ?? 'hotspots unavailable'} />
      ) : (
        <>
          <HotspotsSummary hotspots={hotspots} sessionCount={sessionCount} />
          {hotspots.clusters.map((cluster, i) => (
            <Box key={i} flexDirection="column" marginTop={1}>
              <Box marginLeft={2}>
                <Box width={52} flexShrink={0}>
                  <Text bold>{`${i + 1}. ${singleLine(cluster.theme, 48)}`}</Text>
                </Box>
                <Text color="magenta">{`→ ${cluster.artifact}`}</Text>
              </Box>
              <Box marginLeft={5}>
                <Text dimColor>{clusterMetaLine(cluster)}</Text>
              </Box>
              {cluster.examples.map((example, j) => (
                <Box key={j} marginLeft={5}>
                  <Text>{`“${singleLine(example, 70)}”`}</Text>
                </Box>
              ))}
              {cluster.draft.split('\n').slice(0, 3).map((line, j) => (
                <Box key={j} marginLeft={5}>
                  <Text color="cyan">{j === 0 ? 'draft │ ' : '      │ '}</Text>
                  <Text>{singleLine(line, 65)}</Text>
                </Box>
              ))}
            </Box>
          ))}
          {hotspots.note !== null && <NoteLine note={hotspots.note} />}
        </>
      )}
    </Box>
  );
}

/** The repetition-rate and directive-count lines shared with the tab view. */
export function HotspotsSummary({
  hotspots,
  sessionCount,
}: {
  hotspots: HotspotsReport;
  sessionCount: number;
}): ReactElement {
  return (
    <Box flexDirection="column">
      {hotspots.repetitionRate !== null && (
        <Box marginLeft={2}>
          <Text>
            <Text bold>{`repetition rate ${pct1(hotspots.repetitionRate)}`}</Text>
            <Text dimColor>
              {` — ${Math.round(hotspots.repetitionRate * sessionCount)} of ${sessionCount} ` +
                'sessions repeat guidance given elsewhere'}
            </Text>
          </Text>
        </Box>
      )}
      <Box marginLeft={2}>
        <Text dimColor>
          {`${hotspots.directiveCount} directives across ${hotspots.sessionsWithDirectives} sessions`}
        </Text>
      </Box>
    </Box>
  );
}

export function clusterMetaLine(cluster: {
  sessionCount: number;
  directiveCount: number;
  kinds: readonly string[];
  repeated: boolean;
}): string {
  return (
    `${cluster.sessionCount} ${cluster.sessionCount === 1 ? 'session' : 'sessions'} · ` +
    `${cluster.directiveCount} directives (${cluster.kinds.join(', ')})` +
    (cluster.repeated ? '' : ' · repeated within one session')
  );
}
