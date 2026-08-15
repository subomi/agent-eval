/**
 * The eval report as an Ink component (replaces `src/cli/report.ts`):
 * per-metric score bars with turn-cited evidence and advice, then an overall
 * summary with the top advice across metrics. Emitted once to stdout via
 * `<Static>` (see `artifact.tsx`); kept readable at ~80 columns.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { Finding } from '../../metrics/index.js';
import type { RunMetricRecord, RunRecord } from '../../pipeline/evaluate.js';
import { STATUS_BADGES, scoreBarText, scoreColor, targetColor } from './theme.js';

const WIDTH = 80;

/**
 * Pick the most actionable advice across metrics: lowest-scoring metrics
 * have the most room to improve, so their advice ranks first (round-robin
 * across metrics, deduplicated).
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

function Bar({ score }: { score: number }): ReactElement {
  return <Text color={scoreColor(score)}>{scoreBarText(score)}</Text>;
}

function FindingLine({
  finding,
  statusWidth,
}: {
  finding: Finding;
  statusWidth: number;
}): ReactElement {
  const badge = finding.status === undefined ? undefined : STATUS_BADGES[finding.status];
  return (
    <Box marginLeft={4}>
      <Box width={8} flexShrink={0}>
        <Text color="gray">{`turn ${String(finding.turnRef).padStart(3)}`}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} marginLeft={2}>
        {badge === undefined || finding.status === undefined ? (
          <Text>{finding.note}</Text>
        ) : (
          <>
            <Text>
              <Text color={badge.color}>{`${badge.glyph} ${finding.status.padEnd(statusWidth)}`}</Text>
              {'  '}
              {finding.label !== undefined ? (
                <Text bold>{finding.label}</Text>
              ) : (
                <Text>{finding.note}</Text>
              )}
            </Text>
            {finding.label !== undefined && (
              <Box marginLeft={2}>
                <Text dimColor>{finding.note}</Text>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

function MetricBlock({
  metric,
  nameWidth,
}: {
  metric: RunMetricRecord;
  nameWidth: number;
}): ReactElement {
  const statusWidth = Math.max(0, ...metric.findings.map((f) => f.status?.length ?? 0));
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={nameWidth} flexShrink={0}>
          <Text bold>{metric.name}</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text color={targetColor(metric.target)}>{`[${metric.target}]`}</Text>
        </Box>
        <Bar score={metric.score} />
        <Text>{'  '}</Text>
        <Text color={scoreColor(metric.score)}>{metric.score.toFixed(2)}</Text>
      </Box>
      {metric.findings.map((finding, i) => (
        <FindingLine key={i} finding={finding} statusWidth={statusWidth} />
      ))}
      {metric.advice.length > 0 && (
        <Box flexDirection="column" marginLeft={4} marginTop={metric.findings.length > 0 ? 1 : 0}>
          <Text dimColor>advice</Text>
          {metric.advice.map((advice, i) => (
            <Box key={i}>
              <Box width={2} flexShrink={0}>
                <Text color="cyan">•</Text>
              </Box>
              <Box flexGrow={1}>
                <Text>{advice}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function Report({ run }: { run: RunRecord }): ReactElement {
  const stats = run.sessionStats;
  const nameWidth = Math.max(...run.metrics.map((m) => m.name.length)) + 2;
  const best = topAdvice(run.metrics);

  return (
    <Box flexDirection="column" width={WIDTH}>
      <Text bold>{`Session  ${run.title}`}</Text>
      <Box marginLeft={9}>
        <Text dimColor>
          {`${run.project} · ${run.agent} · ${stats.turnCount} turns ` +
            `(${stats.userTurnCount} user / ${stats.assistantTurnCount} assistant) · ` +
            `${stats.toolCallCount} tool calls`}
        </Text>
      </Box>
      <Text>
        <Text bold>Judge</Text>
        {'    '}
        <Text dimColor>{`${run.model} · ${run.evaluatedAt}`}</Text>
      </Text>
      <Box height={1} />
      {run.metrics.map((metric) => (
        <MetricBlock key={metric.id} metric={metric} nameWidth={nameWidth} />
      ))}
      <Text dimColor>{'─'.repeat(WIDTH)}</Text>
      <Box>
        <Box width={nameWidth + 10} flexShrink={0}>
          <Text bold>Overall</Text>
        </Box>
        <Bar score={run.overallScore} />
        <Text>{'  '}</Text>
        <Text color={scoreColor(run.overallScore)}>{run.overallScore.toFixed(2)}</Text>
        <Text dimColor>
          {`  (average of ${run.metrics.length} ${run.metrics.length === 1 ? 'metric' : 'metrics'})`}
        </Text>
      </Box>
      {best.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Top advice</Text>
          {best.map((item, i) => (
            <Box key={i}>
              <Box width={4} flexShrink={0}>
                <Text>{` ${i + 1}.`}</Text>
              </Box>
              <Box flexGrow={1} marginLeft={1}>
                <Text>
                  <Text dimColor>{`[${item.metricName}]`}</Text> {item.advice}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
