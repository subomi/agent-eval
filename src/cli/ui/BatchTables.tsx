/**
 * Batch stdout artifacts: the `--dry-run` work plan and the end-of-batch
 * per-session summary table.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { singleLine } from '../format.js';
import { scoreColor } from './theme.js';

// ---------------------------------------------------------------------------
// --dry-run work plan
// ---------------------------------------------------------------------------

export interface PlanTableRow {
  id: string;
  turns: number;
  toRun: number;
  cached: number;
  title: string;
}

export interface BatchPlanProps {
  rows: readonly PlanTableRow[];
  judgeModel: string;
  minTurns: number;
  skippedMinTurns: number;
  unreadable: number;
}

export function BatchPlan({
  rows,
  judgeModel,
  minTurns,
  skippedMinTurns,
  unreadable,
}: BatchPlanProps): ReactElement {
  const totalRun = rows.reduce((sum, r) => sum + r.toRun, 0);
  const totalCached = rows.reduce((sum, r) => sum + r.cached, 0);
  // Explicit width keeps table rows on single lines when stdout is a pipe.
  const tableWidth = 36 + 2 + 5 + 2 + 4 + 2 + 6 + 2 + 44;

  return (
    <Box flexDirection="column" width={tableWidth}>
      <Text bold>{`Batch work plan (dry run) — judge ${judgeModel}, no judge calls made`}</Text>
      <Box height={1} />
      <Text dimColor>
        {`${'SESSION ID'.padEnd(36)}  ${'TURNS'.padStart(5)}  ${'RUN'.padStart(4)}  ${'CACHED'.padStart(6)}  TITLE`}
      </Text>
      {rows.map((row) => (
        <Text key={row.id}>
          {`${row.id.padEnd(36)}  ${String(row.turns).padStart(5)}  `}
          {row.toRun > 0 ? (
            <Text color="cyan">{String(row.toRun).padStart(4)}</Text>
          ) : (
            <Text dimColor>{String(row.toRun).padStart(4)}</Text>
          )}
          {'  '}
          <Text dimColor>{String(row.cached).padStart(6)}</Text>
          {`  ${singleLine(row.title, 44)}`}
        </Text>
      ))}
      <Box height={1} />
      <Text>
        {`${rows.length} ${rows.length === 1 ? 'session' : 'sessions'} · `}
        <Text color="cyan">{`${totalRun} metric-pairs to run`}</Text>
        {` · ${totalCached} cached/skipped`}
      </Text>
      {(skippedMinTurns > 0 || unreadable > 0) && (
        <Text dimColor>
          {`(${skippedMinTurns} sessions under --min-turns ${minTurns}` +
            (unreadable > 0 ? `, ${unreadable} unreadable` : '') +
            ')'}
        </Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// End-of-batch summary
// ---------------------------------------------------------------------------

export interface SummaryTableRow {
  id: string;
  score: number | undefined;
  evaluated: number;
  cached: number;
  failed: number;
  turns: number;
  title: string;
}

export interface DirectiveTotals {
  extracted: number;
  cached: number;
  failed: number;
}

export function BatchSummary({
  rows,
  directives,
}: {
  rows: readonly SummaryTableRow[];
  directives?: DirectiveTotals;
}): ReactElement {
  const totals = rows.reduce(
    (acc, r) => ({
      evaluated: acc.evaluated + r.evaluated,
      cached: acc.cached + r.cached,
      failed: acc.failed + r.failed,
    }),
    { evaluated: 0, cached: 0, failed: 0 },
  );
  // Explicit width keeps table rows on single lines when stdout is a pipe.
  const tableWidth = 36 + 2 + 5 + 2 + 4 + 2 + 6 + 2 + 4 + 2 + 5 + 2 + 32;

  return (
    <Box flexDirection="column" width={tableWidth}>
      <Text dimColor>
        {`${'SESSION ID'.padEnd(36)}  ${'SCORE'.padStart(5)}  ${'NEW'.padStart(4)}  ` +
          `${'CACHED'.padStart(6)}  ${'FAIL'.padStart(4)}  ${'TURNS'.padStart(5)}  TITLE`}
      </Text>
      {rows.map((row) => (
        <Text key={row.id}>
          {`${row.id.padEnd(36)}  `}
          {row.score === undefined ? (
            <Text dimColor>{'—'.padStart(5)}</Text>
          ) : (
            <Text color={scoreColor(row.score)}>{row.score.toFixed(2).padStart(5)}</Text>
          )}
          {`  ${String(row.evaluated).padStart(4)}  ${String(row.cached).padStart(6)}  `}
          {row.failed > 0 ? (
            <Text color="red">{String(row.failed).padStart(4)}</Text>
          ) : (
            <Text dimColor>{String(row.failed).padStart(4)}</Text>
          )}
          {`  ${String(row.turns).padStart(5)}  ${singleLine(row.title, 32)}`}
        </Text>
      ))}
      <Box height={1} />
      <Text>
        {`${rows.length} ${rows.length === 1 ? 'session' : 'sessions'} · ` +
          `${totals.evaluated} evaluated · ${totals.cached} cached · ${totals.failed} failed`}
      </Text>
      {directives !== undefined && (
        <Text dimColor>
          {`directives: ${directives.extracted} extracted · ${directives.cached} cached` +
            (directives.failed > 0 ? ` · ${directives.failed} failed` : '')}
        </Text>
      )}
    </Box>
  );
}
