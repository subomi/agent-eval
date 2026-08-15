/**
 * The interactive tabbed insights app — the TTY default for
 * `agent-evals insights`. Unlike the one-shot artifacts, this stays mounted
 * until quit: a header (session count/range/filters), one of four tabs, and
 * a footer with the tab bar and key hints.
 *
 * All input lives here — the tabs stay pure functions of the report plus
 * presentation props (width/rows/selection), which is what lets a later
 * phase swap a tab's body for a judge-composed spec renderer without
 * touching this shell.
 *
 * When the composer produced a validated spec for a tab, that tab's body is
 * the spec renderer (marked with ✦ in the footer); tabs without a spec keep
 * their deterministic body. The shell itself is identical either way.
 *
 * Keys: ←/→ or h/l cycle tabs, 1-4 jump, ↑/↓ or j/k select a hotspot
 * cluster (deterministic Hotspots tab), q/Esc/Ctrl-C quit.
 */

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import { TAB_KEYS, type InsightsTabSpecs } from '../../../insights/compose.js';
import type { InsightsReport } from '../../../insights/index.js';
import { SpecTabView } from './catalog.js';
import { HotspotsTab } from './HotspotsTab.js';
import { LeverageTab } from './LeverageTab.js';
import { OverviewTab } from './OverviewTab.js';
import { MAX_WIDTH, ReportHeader } from './shared.js';
import { TrendsTab } from './TrendsTab.js';

const TABS = ['Overview', 'Trends', 'Leverage', 'Hotspots'] as const;
const HOTSPOTS_TAB = 3;

/** Terminal size from stdout, live across SIGWINCH resizes. */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = (): { columns: number; rows: number } => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = (): void => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

export function InsightsApp({
  report,
  specs,
}: {
  report: InsightsReport;
  /** Judge-composed tab specs; null (or a null entry) = deterministic tab. */
  specs?: InsightsTabSpecs | null;
}): ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const width = Math.max(60, Math.min(columns, MAX_WIDTH));
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState(0);
  const clusterCount = report.hotspots.clusters.length;
  const composed = TAB_KEYS.map((key) => (specs?.[key] ?? null) !== null);
  const activeSpec = specs?.[TAB_KEYS[tab]!] ?? null;

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.leftArrow || input === 'h') {
      setTab((t) => (t + TABS.length - 1) % TABS.length);
      return;
    }
    if (key.rightArrow || input === 'l') {
      setTab((t) => (t + 1) % TABS.length);
      return;
    }
    if (/^[1-4]$/.test(input)) {
      setTab(Number(input) - 1);
      return;
    }
    if (tab === HOTSPOTS_TAB && !composed[HOTSPOTS_TAB] && clusterCount > 0) {
      if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') setSelected((s) => Math.min(clusterCount - 1, s + 1));
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <ReportHeader report={report} />
      {activeSpec !== null ? (
        <SpecTabView spec={activeSpec} report={report} width={width} />
      ) : (
        <>
          {tab === 0 && <OverviewTab report={report} width={width} />}
          {tab === 1 && <TrendsTab report={report} width={width} />}
          {tab === 2 && <LeverageTab report={report} width={width} />}
          {tab === HOTSPOTS_TAB && (
            <HotspotsTab report={report} width={width} rows={rows} selected={selected} />
          )}
        </>
      )}
      <Footer
        active={tab}
        composed={composed}
        showSelect={tab === HOTSPOTS_TAB && !composed[HOTSPOTS_TAB] && clusterCount > 0}
        width={width}
      />
    </Box>
  );
}

function Footer({
  active,
  composed,
  showSelect,
  width,
}: {
  active: number;
  /** Per-tab flag: true when the tab body is a judge-composed spec. */
  composed: readonly boolean[];
  showSelect: boolean;
  width: number;
}): ReactElement {
  const hints = `${showSelect ? '↑/↓ select · ' : ''}←/→ or 1-4 switch · q quit`;
  return (
    <Box marginTop={1} width={width} justifyContent="space-between">
      <Text>
        {TABS.map((name, i) => {
          const label = ` ${i + 1} ${name}${composed[i] === true ? '✦' : ''} `;
          return (
            <Text key={name}>
              {i > 0 ? ' ' : ''}
              {i === active ? (
                <Text bold inverse>
                  {label}
                </Text>
              ) : (
                <Text dimColor>{label}</Text>
              )}
            </Text>
          );
        })}
      </Text>
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
