/**
 * Live per-metric progress for a single-session eval, rendered to stderr.
 * Driven from outside React: the command mutates a snapshot and calls
 * `rerender` on each pipeline event.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { useSpinnerFrame } from './hooks.js';
import { scoreColor } from './theme.js';

export type ProgressMetricStatus = 'running' | 'evaluated' | 'cached' | 'failed';

export interface ProgressMetric {
  id: string;
  name: string;
  status: ProgressMetricStatus;
  score?: number;
}

export interface EvalProgressProps {
  header: string;
  note?: string | undefined;
  metrics: readonly ProgressMetric[];
  done: boolean;
}

function MetricLine({ metric, frame }: { metric: ProgressMetric; frame: string }): ReactElement {
  switch (metric.status) {
    case 'running':
      return (
        <Text>
          {'  '}
          <Text color="cyan">{frame}</Text> {metric.name}…
        </Text>
      );
    case 'evaluated':
      return (
        <Text>
          {'  '}
          <Text color="green">✓</Text> {metric.name}{' '}
          <Text color={scoreColor(metric.score ?? 0)}>{(metric.score ?? 0).toFixed(2)}</Text>
        </Text>
      );
    case 'cached':
      return (
        <Text>
          {'  '}
          <Text color="blue">↺</Text> {metric.name}{' '}
          <Text color={scoreColor(metric.score ?? 0)}>{(metric.score ?? 0).toFixed(2)}</Text>
          <Text dimColor> (already evaluated)</Text>
        </Text>
      );
    case 'failed':
      return (
        <Text>
          {'  '}
          <Text color="red">✗ {metric.name} failed</Text>
        </Text>
      );
  }
}

export function EvalProgress({ header, note, metrics, done }: EvalProgressProps): ReactElement {
  const frame = useSpinnerFrame(!done);
  const settled = metrics.filter((m) => m.status !== 'running').length;

  return (
    <Box flexDirection="column">
      <Text>
        {done ? <Text color="green">✓</Text> : <Text color="cyan">{frame}</Text>} {header}
        {note !== undefined && note.length > 0 && <Text dimColor> {note}</Text>}
      </Text>
      {metrics.map((metric) => (
        <MetricLine key={metric.id} metric={metric} frame={frame} />
      ))}
      <Text dimColor>{`  ${settled}/${metrics.length} metrics settled`}</Text>
    </Box>
  );
}
