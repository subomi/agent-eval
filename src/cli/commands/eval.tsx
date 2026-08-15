/**
 * `agent-evals [eval]` — evaluate one session (a batch of one). Rewired onto
 * the DB-backed pipeline: metric pairs already evaluated for this transcript
 * state are served from the DB unless `--force`.
 *
 * Stream discipline: the final artifact (Ink report via <Static>, or the
 * `--json` run record) goes to stdout; picker and progress go to stderr.
 */

import { render } from 'ink';
import type { ReactElement } from 'react';

import { sourceById, type SessionSource } from '../../adapters/index.js';
import { DIRECTIVE_EXTRACTOR_VERSION, extractDirectives } from '../../extract/directives.js';
import { allMetrics } from '../../metrics/index.js';
import type { Session } from '../../model/session.js';
import { evaluateSessions, type PipelineEvents } from '../../pipeline/evaluate.js';
import { openDb } from '../../store/db.js';
import type { EvalOptions } from '../args.js';
import { singleLine } from '../format.js';
import { EvalProgress, type ProgressMetric } from '../ui/EvalProgress.js';
import { Picker, type PickerEntry } from '../ui/Picker.js';
import { Report } from '../ui/Report.js';
import { printArtifact } from '../ui/artifact.js';
import {
  DEFAULT_SESSION_LIMIT,
  errorMessage,
  listSessionsAcrossSources,
  loadConfigWithNotice,
  resolveSessionAcrossSources,
  resolveSources,
  selectMetrics,
  setupJudge,
} from './shared.js';

export async function runEvalCommand(options: EvalOptions): Promise<number> {
  const metrics = selectMetrics(options.metrics);
  const fancy = process.stderr.isTTY === true;
  const config = loadConfigWithNotice();
  const sources = resolveSources(options.agents, config);

  // 1. Resolve the session.
  let session: Session;
  if (options.session !== undefined) {
    session = await resolveSessionAcrossSources(options.session, sources);
  } else {
    if (process.stdin.isTTY !== true || !fancy) {
      throw new Error(
        'interactive picker needs a terminal; pass --session <uuid|path> (find one with `agent-evals list`)',
      );
    }
    const picked = await pickSessionInteractively(options.limit ?? DEFAULT_SESSION_LIMIT, sources);
    if (picked === undefined) return 130; // user cancelled
    session = picked;
  }

  // 2. Resolve the judge (config.toml keys + pinned model; fails fast without a key).
  const { judge, modelRef } = await setupJudge({
    model: options.model,
    cache: options.cache,
    config,
  });

  const noteParts: string[] = [];
  if (!options.cache) noteParts.push('(cache disabled)');
  if (options.force) noteParts.push('(force)');
  if (metrics.length !== allMetrics.length) {
    noteParts.push(`(${metrics.map((m) => m.id).join(', ')})`);
  }
  const header =
    `Evaluating "${singleLine(session.title, 60)}" ` +
    `(${session.turns.length} turns) with judge ${modelRef}`;
  const note = noteParts.join(' ');

  // 3. Run through the shared pipeline with live progress on stderr.
  const db = openDb();
  try {
    const progress = startEvalProgress(fancy, header, note, metrics);
    const [outcome] = await evaluateSessions([session], {
      db,
      judge,
      judgeModel: modelRef,
      metrics,
      force: options.force,
      extractor: { version: DIRECTIVE_EXTRACTOR_VERSION, extract: extractDirectives },
      events: progress.events,
    });
    progress.finish();

    for (const failure of outcome!.outcomes.filter((o) => o.status === 'failed')) {
      console.error(`agent-evals: ✗ ${failure.metric.name} failed: ${errorMessage(failure.error)}`);
    }
    if (outcome!.directives === 'failed') {
      console.error('agent-evals: ✗ directive extraction failed (metric results are unaffected)');
    }
    if (outcome!.run === undefined) {
      throw new Error('every metric failed; see errors above');
    }

    // 4. Emit the artifact to stdout (--json bypasses Ink entirely).
    if (options.json) {
      process.stdout.write(`${JSON.stringify(outcome!.run, null, 2)}\n`);
    } else {
      await printArtifact(<Report run={outcome!.run} />);
    }
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Progress driver (Ink on TTY stderr, plain console.error lines otherwise)
// ---------------------------------------------------------------------------

interface ProgressDriver {
  events: PipelineEvents;
  finish(): void;
}

function startEvalProgress(
  fancy: boolean,
  header: string,
  note: string,
  metrics: readonly { id: string; name: string }[],
): ProgressDriver {
  if (!fancy) {
    console.error(note.length > 0 ? `${header} ${note}` : header);
    return {
      events: {
        onMetricSettled: ({ outcome, settledCount, metricCount }) => {
          const glyph =
            outcome.status === 'cached' ? '↺' : outcome.status === 'failed' ? '✗' : '✓';
          const score = outcome.row === undefined ? '' : ` ${outcome.row.score.toFixed(2)}`;
          const suffix = outcome.status === 'cached' ? ' (already evaluated)' : '';
          console.error(
            `  ${glyph} ${outcome.metric.name}${score}${suffix} (${settledCount}/${metricCount})`,
          );
        },
      },
      finish: () => {},
    };
  }

  let state: ProgressMetric[] = metrics.map((m) => ({
    id: m.id,
    name: m.name,
    status: 'running' as const,
  }));
  const view = (done: boolean): ReactElement => (
    <EvalProgress header={header} note={note} metrics={state} done={done} />
  );
  const instance = render(view(false), {
    stdout: process.stderr,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  return {
    events: {
      onMetricSettled: ({ outcome }) => {
        state = state.map((m) => {
          if (m.id !== outcome.metric.id) return m;
          const next: ProgressMetric = { id: m.id, name: m.name, status: outcome.status };
          if (outcome.row !== undefined) next.score = outcome.row.score;
          return next;
        });
        instance.rerender(view(false));
      },
    },
    finish: () => {
      instance.rerender(view(true));
      instance.unmount();
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive picker
// ---------------------------------------------------------------------------

async function pickSessionInteractively(
  limit: number,
  sources: readonly SessionSource[],
): Promise<Session | undefined> {
  console.error(`Scanning recent sessions (${sources.map((s) => s.id).join(', ')})…`);
  const metas = await listSessionsAcrossSources(sources, { limit });
  if (metas.length === 0) {
    throw new Error(`no sessions found for agents ${sources.map((s) => s.id).join(', ')}`);
  }

  // Load each transcript up front: real turn counts in the picker, and the
  // chosen session is instantly available.
  const entries: PickerEntry[] = await Promise.all(
    metas.map(async (meta) => {
      try {
        return { meta, session: await sourceById(meta.agent)!.loadSession(meta) };
      } catch {
        return { meta, session: undefined };
      }
    }),
  );

  const index = await new Promise<number | undefined>((resolve) => {
    const instance = render(
      <Picker
        entries={entries}
        showAgent={sources.length > 1}
        onSubmit={(i) => {
          instance.unmount();
          resolve(i);
        }}
        onCancel={() => {
          instance.unmount();
          resolve(undefined);
        }}
      />,
      { stdout: process.stderr, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false },
    );
  });

  if (index === undefined) {
    console.error('Cancelled.');
    return undefined;
  }
  const chosen = entries[index];
  if (chosen?.session === undefined) {
    throw new Error(`could not read the transcript for session ${chosen?.meta.id ?? index}`);
  }
  return chosen.session;
}
