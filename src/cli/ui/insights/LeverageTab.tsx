/**
 * Leverage tab: the Agent Leverage composite — headline, window comparison,
 * and the full component table with percentile bars. Pure function of the
 * report (plus a width budget) so a later phase can swap the body for a
 * judge-composed spec renderer.
 */

import { Box } from 'ink';
import type { ReactElement } from 'react';

import type { InsightsReport } from '../../../insights/index.js';
import { CompositeSection } from './sections.js';

export function LeverageTab({
  report,
  width,
}: {
  report: InsightsReport;
  width: number;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <CompositeSection composite={report.composite} width={width} />
    </Box>
  );
}
