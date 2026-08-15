/**
 * The one-shot insights artifact (non-TTY stdout, or `--static`): the
 * historical 80-column layout, composed from the same section components
 * the interactive tabs use. Leads with the plain-language summary, then
 * deterministic trends, judged trends, the composite, and the compact
 * hotspots dump.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { InsightsReport } from '../../../insights/index.js';
import {
  CompositeSection,
  DeterministicSection,
  HotspotsSection,
  JudgedSection,
} from './sections.js';
import { NoteLine, ReportHeader, STATIC_WIDTH } from './shared.js';

export function StaticInsights({ report }: { report: InsightsReport }): ReactElement {
  return (
    <Box flexDirection="column" width={STATIC_WIDTH}>
      <ReportHeader report={report} />
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
      <DeterministicSection trends={report.deterministicTrends} width={STATIC_WIDTH} />
      <JudgedSection trends={report.judgedTrends} width={STATIC_WIDTH} />
      <CompositeSection composite={report.composite} width={STATIC_WIDTH} />
      <HotspotsSection hotspots={report.hotspots} sessionCount={report.sessions.count} />
    </Box>
  );
}
