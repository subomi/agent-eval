/**
 * The "answer" tab: the plain-language summary verdict, the leverage
 * headline with its delta, the biggest week-over-week movers, and the top
 * repetition hotspot. Pure function of the report (plus a width budget) so
 * a later phase can swap the body for a judge-composed spec renderer.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { DeterministicTrend, InsightsReport } from '../../../insights/index.js';
import { compositeBand } from '../../../insights/index.js';
import { singleLine } from '../../format.js';
import { scoreColor } from '../theme.js';
import { arrowFor, formatValue, NoteLine, points, signedPoints } from './shared.js';

const LABEL_WIDTH = 12;

interface Mover {
  trend: DeterministicTrend;
  improved: boolean;
  /** Relative change magnitude, for ranking movers across units. */
  magnitude: number;
}

function movers(trends: readonly DeterministicTrend[]): Mover[] {
  const out: Mover[] = [];
  for (const trend of trends) {
    if (trend.direction === null || trend.direction === 'flat') continue;
    if (trend.latest === null || trend.previous === null) continue;
    out.push({
      trend,
      improved: trend.direction === 'down' ? trend.lowerIsBetter : !trend.lowerIsBetter,
      magnitude: Math.abs(trend.latest - trend.previous) / Math.max(Math.abs(trend.previous), 1e-9),
    });
  }
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

function Row({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <Box marginLeft={2}>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      {children}
    </Box>
  );
}

function MoverRow({ label, mover }: { label: string; mover: Mover }): ReactElement {
  const arrow = arrowFor(mover.trend);
  return (
    <Row label={label}>
      <Text>
        <Text>{mover.trend.label}</Text>
        <Text color={arrow.color}>{` ${arrow.text} ${arrow.word}`}</Text>
        <Text dimColor>
          {mover.trend.latest === null
            ? ''
            : ` · now ${formatValue(mover.trend.latest, mover.trend.unit)}`}
        </Text>
      </Text>
    </Row>
  );
}

export function OverviewTab({
  report,
  width,
}: {
  report: InsightsReport;
  width: number;
}): ReactElement {
  const { composite, hotspots } = report;
  const ranked = movers(report.deterministicTrends);
  const improving = ranked.find((m) => m.improved);
  const worsening = ranked.find((m) => !m.improved);
  const topCluster = hotspots.status === 'ok' ? hotspots.clusters[0] : undefined;

  return (
    <Box flexDirection="column">
      {report.summary.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {report.summary.map((line, i) => (
            <Box key={i} marginLeft={2}>
              <Text bold={i === 0}>{line}</Text>
            </Box>
          ))}
        </Box>
      )}
      {report.notes.map((note, i) => (
        <NoteLine key={i} note={note} />
      ))}

      <Box height={1} />
      <Row label="Leverage">
        {composite.headline === null ? (
          <Text dimColor>{composite.note ?? 'not enough data for the composite yet'}</Text>
        ) : (
          <Text>
            <Text bold color={scoreColor(composite.headline)}>
              {`${points(composite.headline)} / 100`}
            </Text>
            <Text dimColor>{` — ${compositeBand(composite.headline)}`}</Text>
            {composite.delta4w !== null && (
              <Text color={composite.delta4w > 0 ? 'green' : composite.delta4w < 0 ? 'red' : 'gray'}>
                {` · ${signedPoints(composite.delta4w)} vs prior ${composite.windowWeeks}w`}
              </Text>
            )}
          </Text>
        )}
      </Row>

      {improving !== undefined && <MoverRow label="Improving" mover={improving} />}
      {worsening !== undefined && <MoverRow label="Worsening" mover={worsening} />}
      {improving === undefined && worsening === undefined && (
        <Row label="Trends">
          <Text dimColor>no week-over-week movement yet — trends need 2+ weeks of history</Text>
        </Row>
      )}

      <Row label="Hotspot">
        {topCluster === undefined ? (
          <Text dimColor>
            {hotspots.status === 'ok'
              ? 'no repeated guidance detected'
              : (hotspots.note ?? 'hotspots unavailable')}
          </Text>
        ) : (
          <Text>
            <Text>{`“${singleLine(topCluster.theme, Math.max(20, width - 40))}”`}</Text>
            <Text color="magenta">{` → ${topCluster.artifact}`}</Text>
            <Text dimColor>
              {` · ${topCluster.sessionCount} ${topCluster.sessionCount === 1 ? 'session' : 'sessions'}`}
            </Text>
          </Text>
        )}
      </Row>

      <Box height={1} />
      <Box marginLeft={2}>
        <Text dimColor>details: 2 Trends · 3 Leverage · 4 Hotspots</Text>
      </Box>
    </Box>
  );
}
