/**
 * Live batch progress, rendered to stderr: completed sessions scroll away
 * as `<Static>` lines, the in-flight session renders underneath with a
 * spinner and per-metric settle counts.
 */

import { Box, Static, Text } from 'ink';
import type { ReactElement } from 'react';

import { useSpinnerFrame } from './hooks.js';

export interface BatchDoneLine {
  id: string;
  position: number;
  total: number;
  title: string;
  evaluated: number;
  cached: number;
  failed: number;
}

export interface BatchCurrentLine {
  position: number;
  total: number;
  title: string;
  turns: number;
  settled: number;
  metricCount: number;
}

export interface BatchProgressProps {
  completed: readonly BatchDoneLine[];
  current: BatchCurrentLine | undefined;
  done: boolean;
  totals: { evaluated: number; cached: number; failed: number };
}

function DoneLine({ line }: { line: BatchDoneLine }): ReactElement {
  return (
    <Text>
      <Text color={line.failed > 0 ? 'yellow' : 'green'}>✓</Text>
      <Text dimColor>{` [${line.position}/${line.total}] `}</Text>
      {line.title}
      <Text dimColor>
        {` — ${line.evaluated} new · ${line.cached} cached` +
          (line.failed > 0 ? ` · ${line.failed} failed` : '')}
      </Text>
    </Text>
  );
}

export function BatchProgress({ completed, current, done, totals }: BatchProgressProps): ReactElement {
  const frame = useSpinnerFrame(!done);

  return (
    <Box flexDirection="column">
      <Static items={completed as BatchDoneLine[]}>
        {(line) => <DoneLine key={line.id} line={line} />}
      </Static>
      {current !== undefined && !done && (
        <Text>
          <Text color="cyan">{frame}</Text>
          <Text dimColor>{` [${current.position}/${current.total}] `}</Text>
          {current.title}
          <Text dimColor>
            {` (${current.turns} turns) — ${current.settled}/${current.metricCount} metrics`}
          </Text>
        </Text>
      )}
      {done && (
        <Text>
          <Text color="green">✓</Text>
          {` Batch done — ${totals.evaluated} evaluated · ${totals.cached} cached · ${totals.failed} failed`}
        </Text>
      )}
    </Box>
  );
}
