/**
 * `agent-evals` command dispatcher: `eval` (default), `list`, `search`,
 * `batch`, `insights`. Commands stay thin — parse args, run the pipeline,
 * hand data to an Ink component.
 *
 * Stream discipline: final artifacts (report, --json run record, list/batch
 * tables) go to stdout; all interaction and progress goes to stderr, so
 * piping stdout stays clean.
 */

import { parseCommandLine, USAGE, UsageError, type ParsedCli } from './args.js';

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`agent-evals: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    switch (parsed.command) {
      case 'eval': {
        const { runEvalCommand } = await import('./commands/eval.js');
        return await runEvalCommand(parsed.options);
      }
      case 'list': {
        const { runListCommand } = await import('./commands/list.js');
        return await runListCommand(parsed.options);
      }
      case 'search': {
        const { runSearchCommand } = await import('./commands/search.js');
        return await runSearchCommand(parsed.options);
      }
      case 'batch': {
        const { runBatchCommand } = await import('./commands/batch.js');
        return await runBatchCommand(parsed.options);
      }
      case 'insights': {
        const { runInsightsCommand } = await import('./commands/insights.js');
        return await runInsightsCommand(parsed.options);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`agent-evals: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`agent-evals: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
