/**
 * `agent-evals batch` — evaluate many sessions through the shared idempotent
 * pipeline. `--dry-run` prints the work plan (which metric pairs would run
 * vs. are already stored) with zero judge calls; the real run streams
 * progress to stderr and prints a compact per-session summary table to
 * stdout.
 */

import { render } from 'ink';
import type { ReactElement } from 'react';

import { sourceById, type ListSessionsOptions } from '../../adapters/index.js';
import { DIRECTIVE_EXTRACTOR_VERSION, extractDirectives } from '../../extract/directives.js';
import type { Session } from '../../model/session.js';
import {
  evaluateSessions,
  planSessionWork,
  type PipelineEvents,
  type SessionOutcome,
} from '../../pipeline/evaluate.js';
import { openDb } from '../../store/db.js';
import type { BatchOptions } from '../args.js';
import { singleLine } from '../format.js';
import {
  BatchProgress,
  type BatchCurrentLine,
  type BatchDoneLine,
} from '../ui/BatchProgress.js';
import { BatchPlan, BatchSummary, type SummaryTableRow } from '../ui/BatchTables.js';
import { printArtifact } from '../ui/artifact.js';
import {
  errorMessage,
  listSessionsAcrossSources,
  loadConfigWithNotice,
  resolveSources,
  selectMetrics,
  setupJudge,
} from './shared.js';

export async function runBatchCommand(options: BatchOptions): Promise<number> {
  const metrics = selectMetrics(options.metrics);
  const fancy = process.stderr.isTTY === true;
  const config = loadConfigWithNotice();
  const sources = resolveSources(options.agents, config);

  // Judge setup first: the resolved model ref is part of the idempotency
  // key, so even --dry-run needs it (no judge API calls are made).
  const { judge, modelRef } = await setupJudge({
    model: options.model,
    cache: options.cache,
    config,
  });

  console.error(`Scanning sessions (${sources.map((s) => s.id).join(', ')})…`);
  const listOptions: ListSessionsOptions = {};
  if (options.project !== undefined) listOptions.project = options.project;
  let metas = await listSessionsAcrossSources(sources, listOptions);
  if (options.since !== undefined) {
    const sinceMs = options.since.getTime();
    metas = metas.filter((m) => m.updatedAt.getTime() >= sinceMs);
  }

  const loaded = await Promise.all(
    metas.map(async (meta): Promise<Session | undefined> => {
      try {
        return await sourceById(meta.agent)!.loadSession(meta);
      } catch {
        return undefined;
      }
    }),
  );
  const readable = loaded.filter((s): s is Session => s !== undefined);
  const unreadable = loaded.length - readable.length;
  const eligible = readable.filter((s) => s.turns.length >= options.minTurns);
  const skippedMinTurns = readable.length - eligible.length;
  const sessions = options.limit === undefined ? eligible : eligible.slice(0, options.limit);

  if (sessions.length === 0) {
    console.error('agent-evals: no sessions match the batch filters');
    return 1;
  }

  const db = openDb();
  try {
    if (options.dryRun) {
      const plans = sessions.map((s) => planSessionWork(db, s, metrics, modelRef, options.force));
      await printArtifact(
        <BatchPlan
          rows={plans.map((plan) => ({
            id: plan.session.id,
            turns: plan.session.turns.length,
            toRun: plan.toRun.length,
            cached: plan.cached.length,
            title: plan.session.title,
          }))}
          judgeModel={modelRef}
          minTurns={options.minTurns}
          skippedMinTurns={skippedMinTurns}
          unreadable={unreadable}
        />,
      );
      return 0;
    }

    const progress = startBatchProgress(fancy, metrics.length);
    const outcomes = await evaluateSessions(sessions, {
      db,
      judge,
      judgeModel: modelRef,
      metrics,
      force: options.force,
      extractor: { version: DIRECTIVE_EXTRACTOR_VERSION, extract: extractDirectives },
      events: progress.events,
    });
    progress.finish();

    const rows = outcomes.map((outcome): SummaryTableRow => {
      const counts = countStatuses(outcome);
      return {
        id: outcome.session.id,
        score: outcome.run?.overallScore,
        evaluated: counts.evaluated,
        cached: counts.cached,
        failed: counts.failed,
        turns: outcome.session.turns.length,
        title: outcome.session.title,
      };
    });
    const directiveTotals = outcomes.reduce(
      (acc, o) => ({
        extracted: acc.extracted + (o.directives === 'extracted' ? 1 : 0),
        cached: acc.cached + (o.directives === 'cached' ? 1 : 0),
        failed: acc.failed + (o.directives === 'failed' ? 1 : 0),
      }),
      { extracted: 0, cached: 0, failed: 0 },
    );
    await printArtifact(<BatchSummary rows={rows} directives={directiveTotals} />);

    // Non-zero only when the batch produced nothing but failures.
    const totals = rows.reduce(
      (acc, r) => ({ evaluated: acc.evaluated + r.evaluated, failed: acc.failed + r.failed }),
      { evaluated: 0, failed: 0 },
    );
    return totals.failed > 0 && totals.evaluated === 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

function countStatuses(outcome: SessionOutcome): {
  evaluated: number;
  cached: number;
  failed: number;
} {
  let evaluated = 0;
  let cached = 0;
  let failed = 0;
  for (const metric of outcome.outcomes) {
    if (metric.status === 'evaluated') evaluated += 1;
    else if (metric.status === 'cached') cached += 1;
    else failed += 1;
  }
  return { evaluated, cached, failed };
}

// ---------------------------------------------------------------------------
// Progress driver (Ink on TTY stderr, plain console.error lines otherwise)
// ---------------------------------------------------------------------------

interface ProgressDriver {
  events: PipelineEvents;
  finish(): void;
}

function startBatchProgress(fancy: boolean, metricCount: number): ProgressDriver {
  if (!fancy) {
    return {
      events: {
        onSessionStart: ({ index, total, plan }) => {
          console.error(
            `[${index + 1}/${total}] "${singleLine(plan.session.title, 48)}" ` +
              `(${plan.session.turns.length} turns) — ${plan.toRun.length} to run, ` +
              `${plan.cached.length} cached`,
          );
        },
        onMetricSettled: ({ outcome }) => {
          if (outcome.status === 'failed') {
            console.error(`  ✗ ${outcome.metric.name} failed: ${errorMessage(outcome.error)}`);
          }
        },
        onSessionDone: ({ index, total, outcome }) => {
          const counts = countStatuses(outcome);
          console.error(
            `[${index + 1}/${total}] done — ${counts.evaluated} new · ` +
              `${counts.cached} cached · ${counts.failed} failed`,
          );
        },
      },
      finish: () => {},
    };
  }

  let completed: BatchDoneLine[] = [];
  let current: BatchCurrentLine | undefined;
  let totals = { evaluated: 0, cached: 0, failed: 0 };

  const view = (done: boolean): ReactElement => (
    <BatchProgress completed={completed} current={current} done={done} totals={totals} />
  );
  const instance = render(view(false), {
    stdout: process.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    events: {
      onSessionStart: ({ index, total, plan }) => {
        current = {
          position: index + 1,
          total,
          title: singleLine(plan.session.title, 48),
          turns: plan.session.turns.length,
          settled: 0,
          metricCount,
        };
        instance.rerender(view(false));
      },
      onMetricSettled: ({ outcome, settledCount }) => {
        if (current !== undefined) current = { ...current, settled: settledCount };
        totals = {
          evaluated: totals.evaluated + (outcome.status === 'evaluated' ? 1 : 0),
          cached: totals.cached + (outcome.status === 'cached' ? 1 : 0),
          failed: totals.failed + (outcome.status === 'failed' ? 1 : 0),
        };
        instance.rerender(view(false));
      },
      onSessionDone: ({ index, total, outcome }) => {
        const counts = countStatuses(outcome);
        completed = [
          ...completed,
          {
            id: outcome.session.id,
            position: index + 1,
            total,
            title: singleLine(outcome.session.title, 48),
            ...counts,
          },
        ];
        current = undefined;
        instance.rerender(view(false));
      },
    },
    finish: () => {
      instance.rerender(view(true));
      instance.unmount();
    },
  };
}
