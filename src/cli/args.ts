/** Hand-rolled argument parsing for the `agent-evals` binary. */

export class UsageError extends Error {}

export interface CliOptions {
  help: boolean;
  /** Print recent sessions and exit. */
  list: boolean;
  /** Emit the run JSON to stdout instead of the pretty report. */
  json: boolean;
  /** Judge response disk cache (default on; `--no-cache` disables). */
  cache: boolean;
  /** Session uuid or transcript path; skips the interactive picker. */
  session: string | undefined;
  /** Explicit judge model, `"provider/model-id"`. */
  model: string | undefined;
  /** Max sessions listed / offered in the picker. */
  limit: number | undefined;
}

export const USAGE = `agent-evals — evaluate a local coding-agent session with LLM-judge metrics

Usage
  agent-evals                     interactive: pick a recent Cursor session and evaluate it
  agent-evals --list              print recent sessions (id, age, turns, project, title) and exit
  agent-evals --session <ref>     evaluate a session by uuid or transcript path (skips the picker)

Options
  --list                 list recent sessions and exit
  --session, -s <ref>    session uuid or path to a transcript .jsonl
  --model, -m <ref>      judge model as "provider/model-id" (default: auto-picked
                         from providers with an API key in the environment)
  --limit, -n <n>        max sessions to list / offer in the picker (default 15)
  --no-cache             bypass the judge response cache in ~/.agent-evals/cache
  --json                 emit the run JSON to stdout instead of the pretty report
  --help, -h             show this help

Environment
  Provider API keys are read from the environment (or .env.local / .env in the
  working directory): ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
  OPENROUTER_API_KEY, XAI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY.

Files
  ~/.agent-evals/runs    one JSON file per eval run
  ~/.agent-evals/cache   cached judge responses (re-runs are free)`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    help: false,
    list: false,
    json: false,
    cache: true,
    session: undefined,
    model: undefined,
    limit: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${flag} requires a value`);
      i += 1;
      return next;
    };

    switch (flag) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--list':
        opts.list = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--no-cache':
        opts.cache = false;
        break;
      case '--session':
      case '-s':
        opts.session = takeValue();
        break;
      case '--model':
      case '-m':
        opts.model = takeValue();
        break;
      case '--limit':
      case '-n': {
        const raw = takeValue();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new UsageError(`--limit expects a positive integer, got "${raw}"`);
        }
        opts.limit = parsed;
        break;
      }
      default:
        throw new UsageError(`unknown option "${arg}"`);
    }
  }

  return opts;
}
