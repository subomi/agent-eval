/**
 * The `agent-evals` CLI flow: list recent Cursor sessions -> pick one (or
 * take `--session`) -> resolve the judge model -> run all metrics
 * concurrently with progress -> render the report -> persist the run JSON.
 *
 * Stream discipline: the final artifact (pretty report or `--json` run
 * record) goes to stdout; all interaction and progress (clack UI, spinners,
 * status lines) goes to stderr, so piping stdout stays clean.
 */

import * as p from '@clack/prompts';

import { cursorSource } from '../adapters/index.js';
import { createJudge, type CreateJudgeOptions, type PiJudge } from '../judge/index.js';
import { allMetrics, type Metric, type MetricResult } from '../metrics/index.js';
import type { Session } from '../model/session.js';
import { buildRunRecord, saveRun } from '../store/runs.js';
import { parseArgs, USAGE, UsageError, type CliOptions } from './args.js';
import { bold, cyan, dim, green, red } from './colors.js';
import { relativeAge, singleLine } from './format.js';
import { renderReport } from './report.js';

const DEFAULT_LIMIT = 15;

/** Clack UI goes to stderr so stdout carries only the report / JSON. */
const ui = { output: process.stderr } as const;

const PROVIDER_KEY_HINT = [
  'No LLM provider API key found. Set one of these environment variables',
  '(or put it in .env.local / .env in the working directory):',
  '',
  '  ANTHROPIC_API_KEY    Anthropic (Claude)',
  '  OPENAI_API_KEY       OpenAI (GPT)',
  '  GEMINI_API_KEY       Google (Gemini)',
  '  OPENROUTER_API_KEY   OpenRouter',
  '  XAI_API_KEY          xAI (Grok)',
  '  GROQ_API_KEY         Groq',
  '  MISTRAL_API_KEY      Mistral',
  '  DEEPSEEK_API_KEY     DeepSeek',
  '',
  'Alternatively pass --model "<provider>/<model-id>" to pick a specific model.',
].join('\n');

export async function main(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`agent-evals: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    if (opts.list) return await runList(opts);
    return await runEval(opts);
  } catch (error) {
    console.error(red(`agent-evals: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------

async function runList(opts: CliOptions): Promise<number> {
  const metas = await cursorSource.listSessions({ limit: opts.limit ?? DEFAULT_LIMIT });
  if (metas.length === 0) {
    console.error('agent-evals: no Cursor sessions found under ~/.cursor/projects');
    return 1;
  }

  const rows = await Promise.all(
    metas.map(async (meta) => {
      let turns = '?';
      try {
        turns = String((await cursorSource.loadSession(meta)).turns.length);
      } catch {
        // unreadable transcript; keep the row with unknown turn count
      }
      return { meta, turns };
    }),
  );

  const projWidth = Math.min(28, Math.max(7, ...rows.map((r) => r.meta.project.length)));
  console.log(
    dim(
      `${'SESSION ID'.padEnd(36)}  ${'AGE'.padEnd(8)}  ${'TURNS'.padStart(5)}  ` +
        `${'PROJECT'.padEnd(projWidth)}  TITLE`,
    ),
  );
  for (const { meta, turns } of rows) {
    console.log(
      `${meta.id.padEnd(36)}  ${relativeAge(meta.updatedAt).padEnd(8)}  ${turns.padStart(5)}  ` +
        `${singleLine(meta.project, projWidth).padEnd(projWidth)}  ${singleLine(meta.title, 48)}`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Eval flow
// ---------------------------------------------------------------------------

async function runEval(opts: CliOptions): Promise<number> {
  const fancy = process.stderr.isTTY === true;

  // 1. Resolve the session.
  let session: Session;
  if (opts.session !== undefined) {
    session = await cursorSource.loadSession(opts.session);
  } else {
    if (process.stdin.isTTY !== true || !fancy) {
      throw new Error(
        'interactive picker needs a terminal; pass --session <uuid|path> (find one with --list)',
      );
    }
    const picked = await pickSessionInteractively(opts.limit ?? DEFAULT_LIMIT);
    if (picked === undefined) return 130; // user cancelled
    session = picked;
  }

  // 2. Resolve the judge model (fails fast when no provider key is set).
  const judgeOptions: CreateJudgeOptions = { cache: opts.cache };
  if (opts.model !== undefined) judgeOptions.model = opts.model;
  const judge = createJudge(judgeOptions);

  let modelRef: string;
  try {
    modelRef = await judge.modelRef();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('No LLM provider')) {
      console.error(red('agent-evals: no judge model available.') + '\n\n' + PROVIDER_KEY_HINT);
      return 1;
    }
    throw error;
  }

  const cacheNote = opts.cache ? '' : ' (cache disabled)';
  const announce =
    `Evaluating ${bold(`"${singleLine(session.title, 60)}"`)} ` +
    `${dim(`(${session.turns.length} turns)`)} with judge ${cyan(modelRef)}${dim(cacheNote)}`;
  if (fancy) p.log.info(announce, ui);
  else console.error(announce);

  // 3. Run all metrics concurrently; the judge pools requests internally.
  const outcomes = await runMetrics(session, judge, fancy);
  const succeeded = outcomes.filter(
    (o): o is { metric: Metric; result: MetricResult } => o.result !== undefined,
  );
  const failed = outcomes.filter((o) => o.result === undefined);

  for (const failure of failed) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    const line = red(`✗ ${failure.metric.name} failed: ${message}`);
    if (fancy) p.log.warn(line, ui);
    else console.error(line);
  }
  if (succeeded.length === 0) {
    throw new Error('every metric failed; see errors above');
  }

  // 4. Persist the run, then emit the artifact.
  const run = buildRunRecord({ session, model: modelRef, results: succeeded });
  const runPath = await saveRun(run);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    console.error(dim(`Run saved to ${runPath}`));
  } else {
    if (fancy) p.outro(dim(`Run saved to ${runPath}`), ui);
    else console.error(dim(`Run saved to ${runPath}`));
    console.log(renderReport(run));
  }
  return 0;
}

interface MetricOutcome {
  metric: Metric;
  result?: MetricResult;
  error?: unknown;
}

async function runMetrics(session: Session, judge: PiJudge, fancy: boolean): Promise<MetricOutcome[]> {
  const total = allMetrics.length;
  let done = 0;

  const spin = fancy ? p.spinner(ui) : undefined;
  spin?.start(`Running ${total} metrics…`);

  const report = (metric: Metric, result: MetricResult | undefined): void => {
    done += 1;
    const status =
      result !== undefined
        ? green(`✓ ${metric.name} ${result.score.toFixed(2)}`)
        : red(`✗ ${metric.name}`);
    if (spin) spin.message(`Running metrics… ${done}/${total} · ${status}`);
    else console.error(`  ${status} (${done}/${total})`);
  };

  const outcomes = await Promise.all(
    allMetrics.map(async (metric): Promise<MetricOutcome> => {
      try {
        const result = await metric.evaluate(session, judge);
        report(metric, result);
        return { metric, result };
      } catch (error) {
        report(metric, undefined);
        return { metric, error };
      }
    }),
  );

  const ok = outcomes.filter((o) => o.result !== undefined).length;
  spin?.stop(`Evaluated ${ok}/${total} metrics`);
  return outcomes;
}

// ---------------------------------------------------------------------------
// Interactive picker
// ---------------------------------------------------------------------------

async function pickSessionInteractively(limit: number): Promise<Session | undefined> {
  p.intro(bold('agent-evals'), ui);

  const spin = p.spinner(ui);
  spin.start('Scanning recent Cursor sessions…');
  const metas = await cursorSource.listSessions({ limit });
  // Load each transcript up front: gives the picker real turn counts and
  // makes the chosen session instantly available.
  const loaded = await Promise.all(
    metas.map(async (meta) => {
      try {
        return { meta, session: await cursorSource.loadSession(meta) };
      } catch {
        return { meta, session: undefined };
      }
    }),
  );
  spin.stop(`Found ${loaded.length} recent sessions`);

  if (loaded.length === 0) {
    throw new Error('no Cursor sessions found under ~/.cursor/projects');
  }

  const choice = await p.select<number>({
    message: 'Pick a session to evaluate',
    options: loaded.map((entry, index) => ({
      value: index,
      label: singleLine(entry.meta.title, 56),
      hint:
        `${entry.meta.project} · ${relativeAge(entry.meta.updatedAt)} · ` +
        (entry.session ? `${entry.session.turns.length} turns` : 'unreadable'),
    })),
    maxItems: 12,
    ...ui,
  });

  if (p.isCancel(choice)) {
    p.cancel('Cancelled.', ui);
    return undefined;
  }

  const chosen = loaded[choice];
  if (chosen?.session === undefined) {
    throw new Error(`could not read the transcript for session ${chosen?.meta.id ?? choice}`);
  }
  return chosen.session;
}
