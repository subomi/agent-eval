/**
 * `agent-evals insights` — weekly trends, the Agent Leverage composite, and
 * repetition hotspots, computed entirely at read time from the DB.
 *
 * On a TTY this launches the interactive tabbed app (Overview / Trends /
 * Leverage / Hotspots) and stays mounted until quit; piped stdout or
 * `--static` renders the one-shot artifact instead, and `--json` emits the
 * raw report (plus `viewSpec` when tabs were composed).
 *
 * The judge is touched for at most two disk-cached calls: directive
 * clustering (when there are stored directives) and tab composition (when
 * composing is enabled — interactive or `--json`, not `--plain`, and not
 * disabled via `[insights] compose = false`). Both share one resolved judge;
 * composition failure degrades silently to the deterministic tabs. The
 * static artifact never composes. Stream discipline: the report goes to
 * stdout, judge notices go to stderr before anything mounts.
 */

import { render } from 'ink';

import { composeTabs, type InsightsTabSpecs } from '../../insights/compose.js';
import { buildInsightsReport } from '../../insights/index.js';
import { openDb } from '../../store/db.js';
import type { InsightsOptions } from '../args.js';
import { printArtifact } from '../ui/artifact.js';
import { InsightsApp } from '../ui/insights/App.js';
import { StaticInsights } from '../ui/insights/Static.js';
import {
  loadConfigWithNotice,
  resolveAgentFilter,
  setupJudge,
  type JudgeSetup,
} from './shared.js';

export async function runInsightsCommand(options: InsightsOptions): Promise<number> {
  const config = loadConfigWithNotice();
  const agents = resolveAgentFilter(options.agents, config);

  // One judge for the whole command: hotspot clustering and tab composition
  // share the same lazily-resolved instance.
  let judgePromise: Promise<JudgeSetup> | undefined;
  const resolveJudgeShared = (): Promise<JudgeSetup> =>
    (judgePromise ??= setupJudge({ model: undefined, cache: true, config }));

  const db = openDb();
  try {
    const report = await buildInsightsReport({
      db,
      since: options.since,
      project: options.project,
      agents,
      weights: config.weights,
      resolveJudge: async () => {
        console.error('insights: clustering stored directives (one judge call)…');
        const { judge, modelRef } = await resolveJudgeShared();
        return { judge, modelRef };
      },
    });

    if (report === null) {
      console.error(
        'agent-evals: no sessions in the database match the filters — run `agent-evals batch` first',
      );
      return 1;
    }

    const interactive =
      !options.static && process.stdout.isTTY === true && process.stdin.isTTY === true;

    // Compose the tab specs (one cached judge call). Only for views that can
    // use them — the static artifact stays fully deterministic. Any failure
    // (no API key, judge error, invalid specs) falls back silently.
    let viewSpec: InsightsTabSpecs | null = null;
    if ((interactive || options.json) && !options.plain && config.insightsCompose) {
      try {
        console.error('insights: composing tab layouts (one judge call)…');
        const { judge } = await resolveJudgeShared();
        viewSpec = await composeTabs(report, judge);
      } catch {
        viewSpec = null;
      }
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...report, viewSpec }, null, 2)}\n`);
      return 0;
    }

    if (interactive) {
      const instance = render(<InsightsApp report={report} specs={viewSpec} />, {
        stdout: process.stdout,
        stdin: process.stdin,
        patchConsole: false,
        exitOnCtrlC: false,
      });
      await instance.waitUntilExit();
    } else {
      await printArtifact(<StaticInsights report={report} />);
    }
    return 0;
  } finally {
    db.close();
  }
}
