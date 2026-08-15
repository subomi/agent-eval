/**
 * Hotspots tab: master/detail over the repetition clusters. The master list
 * is one line per cluster (windowed for short terminals); the detail pane
 * renders the selected cluster's full examples and complete draft with no
 * truncation. Selection state lives in the shell — this component stays a
 * pure function of the report plus presentation props, so a later phase can
 * swap the body for a judge-composed spec renderer.
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { HotspotCluster, InsightsReport } from '../../../insights/index.js';
import { singleLine, wrapText } from '../../format.js';
import { clusterMetaLine, HotspotsSummary } from './sections.js';
import { NoteLine, SectionTitle } from './shared.js';

export function HotspotsTab({
  report,
  width,
  rows,
  selected,
}: {
  report: InsightsReport;
  width: number;
  rows: number;
  selected: number;
}): ReactElement {
  const { hotspots } = report;
  return (
    <Box flexDirection="column">
      <SectionTitle title="Repetition hotspots" subtitle="directives clustered into themes · one judge call" />
      {hotspots.status !== 'ok' ? (
        <NoteLine note={hotspots.note ?? 'hotspots unavailable'} />
      ) : hotspots.clusters.length === 0 ? (
        <>
          <HotspotsSummary hotspots={hotspots} sessionCount={report.sessions.count} />
          <NoteLine note="no repeated guidance detected" />
        </>
      ) : (
        <>
          <HotspotsSummary hotspots={hotspots} sessionCount={report.sessions.count} />
          <ClusterList clusters={hotspots.clusters} width={width} rows={rows} selected={selected} />
          <ClusterDetail cluster={hotspots.clusters[selected] ?? hotspots.clusters[0]!} width={width} />
          {hotspots.note !== null && <NoteLine note={hotspots.note} />}
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

function ClusterList({
  clusters,
  width,
  rows,
  selected,
}: {
  clusters: readonly HotspotCluster[];
  width: number;
  rows: number;
  selected: number;
}): ReactElement {
  // Leave room for header, summary, detail pane, and footer on short screens.
  const maxVisible = Math.max(3, Math.min(clusters.length, rows - 16));
  const windowStart = Math.max(
    0,
    Math.min(selected - Math.floor(maxVisible / 2), clusters.length - maxVisible),
  );
  const visible = clusters.slice(windowStart, windowStart + maxVisible);
  const below = clusters.length - windowStart - visible.length;
  const themeBudget = Math.max(20, width - 30);

  return (
    <Box flexDirection="column" marginTop={1}>
      {windowStart > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>{`  ↑ ${windowStart} more`}</Text>
        </Box>
      )}
      {visible.map((cluster, i) => {
        const index = windowStart + i;
        const active = index === selected;
        return (
          <Box key={index} marginLeft={2}>
            <Text {...(active ? { color: 'cyan' as const, bold: true } : {})}>
              {`${active ? '❯ ' : '  '}${index + 1}. ${singleLine(cluster.theme, themeBudget)}`}
            </Text>
            <Text dimColor>
              {` → ${cluster.artifact} · ${cluster.sessionCount} ${
                cluster.sessionCount === 1 ? 'session' : 'sessions'
              }`}
            </Text>
          </Box>
        );
      })}
      {below > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>{`  ↓ ${below} more`}</Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Detail pane: full examples and the complete draft, un-truncated
// ---------------------------------------------------------------------------

const DRAFT_GUTTER = 'draft │ ';

function ClusterDetail({ cluster, width }: { cluster: HotspotCluster; width: number }): ReactElement {
  const bodyWidth = Math.max(20, width - 4);
  const draftWidth = Math.max(20, width - 4 - DRAFT_GUTTER.length);
  const draftLines = cluster.draft
    .split('\n')
    .flatMap((line) => (line.trim().length === 0 ? [''] : wrapText(line, draftWidth)));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginLeft={2}>
        <Text dimColor>{'─'.repeat(Math.max(10, width - 4))}</Text>
      </Box>
      {wrapText(cluster.theme, bodyWidth).map((line, i) => (
        <Box key={i} marginLeft={2}>
          <Text bold>{line}</Text>
        </Box>
      ))}
      <Box marginLeft={2}>
        <Text>
          <Text color="magenta">{`→ ${cluster.artifact}`}</Text>
          <Text dimColor>{` · ${clusterMetaLine(cluster)}`}</Text>
        </Text>
      </Box>
      {cluster.examples.map((example, i) => (
        <Box key={i} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
          {wrapText(`“${example.replace(/\s+/g, ' ').trim()}”`, bodyWidth).map((line, j) => (
            <Box key={j} marginLeft={2}>
              <Text>{line}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box flexDirection="column" marginTop={1}>
        {draftLines.map((line, i) => (
          <Box key={i} marginLeft={2}>
            <Text color="cyan">{i === 0 ? DRAFT_GUTTER : ' '.repeat(DRAFT_GUTTER.length - 2) + '│ '}</Text>
            <Text>{line}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
