/**
 * Trends tab: the deterministic and judged weekly-trend sections with
 * sparklines scaled to the terminal width. Pure function of the report
 * (plus a width budget) so a later phase can swap the body for a
 * judge-composed spec renderer.
 */

import { Box } from 'ink';
import type { ReactElement } from 'react';

import type { InsightsReport } from '../../../insights/index.js';
import { DeterministicSection, JudgedSection } from './sections.js';

export function TrendsTab({
  report,
  width,
}: {
  report: InsightsReport;
  width: number;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <DeterministicSection trends={report.deterministicTrends} width={width} />
      <JudgedSection trends={report.judgedTrends} width={width} />
    </Box>
  );
}
