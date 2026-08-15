/**
 * The `agent-evals list` table (stdout artifact): session id, optional agent
 * column (shown when more than one source is active), age, turns, an
 * evaluated? column sourced from the DB, project, and title.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { singleLine } from '../format.js';

export interface SessionListRow {
  id: string;
  /** Source agent id, e.g. "cursor", "claude-code". */
  agent: string;
  age: string;
  /** Turn count as text ("?" when the transcript is unreadable). */
  turns: string;
  /** Distinct metrics with stored results for the current transcript state. */
  evaluatedMetrics: number;
  project: string;
  title: string;
}

const EVAL_WIDTH = 6;

export function SessionTable({
  rows,
  showAgent = false,
}: {
  rows: readonly SessionListRow[];
  showAgent?: boolean;
}): ReactElement {
  const projWidth = Math.min(28, Math.max(7, ...rows.map((r) => r.project.length)));
  const agentWidth = showAgent ? Math.max(5, ...rows.map((r) => r.agent.length)) : 0;
  const agentPad = showAgent ? agentWidth + 2 : 0;
  // Explicit width so rows stay single lines even when stdout is a pipe
  // (Ink would otherwise wrap at the default 80 columns).
  const tableWidth = 36 + 2 + agentPad + 8 + 2 + 5 + 2 + EVAL_WIDTH + 2 + projWidth + 2 + 48;

  return (
    <Box flexDirection="column" width={tableWidth}>
      <Text dimColor>
        {`${'SESSION ID'.padEnd(36)}  ${showAgent ? `${'AGENT'.padEnd(agentWidth)}  ` : ''}` +
          `${'AGE'.padEnd(8)}  ${'TURNS'.padStart(5)}  ` +
          `${'EVAL'.padEnd(EVAL_WIDTH)}  ${'PROJECT'.padEnd(projWidth)}  TITLE`}
      </Text>
      {rows.map((row) => (
        <Text key={`${row.agent}:${row.id}`}>
          {`${row.id.padEnd(36)}  ${showAgent ? `${row.agent.padEnd(agentWidth)}  ` : ''}` +
            `${row.age.padEnd(8)}  ${row.turns.padStart(5)}  `}
          {row.evaluatedMetrics > 0 ? (
            <Text color="green">{`✓ ${row.evaluatedMetrics}`.padEnd(EVAL_WIDTH)}</Text>
          ) : (
            <Text dimColor>{'·'.padEnd(EVAL_WIDTH)}</Text>
          )}
          {`  ${singleLine(row.project, projWidth).padEnd(projWidth)}  ${singleLine(row.title, 48)}`}
        </Text>
      ))}
    </Box>
  );
}
