/**
 * Hand-rolled subcommand dispatcher for the `agent-evals` binary:
 * `eval` (default), `list`, `search`, `batch`, `insights`, each with its
 * own flags.
 */

export class UsageError extends Error {}

export type CommandName = 'eval' | 'list' | 'search' | 'batch' | 'insights';

const COMMAND_NAMES: readonly CommandName[] = ['eval', 'list', 'search', 'batch', 'insights'];

export interface EvalOptions {
  /** Emit the run record JSON to stdout instead of the pretty report. */
  json: boolean;
  /** Judge response disk cache (default on; `--no-cache` disables). */
  cache: boolean;
  /** Re-run metrics even when the DB already has rows for them. */
  force: boolean;
  /** Session uuid or transcript path; skips the interactive picker. */
  session: string | undefined;
  /** Explicit judge model, `"provider/model-id"`. */
  model: string | undefined;
  /** Max sessions offered in the picker. */
  limit: number | undefined;
  /** Metric ids to run (comma-separated); undefined = all. */
  metrics: string[] | undefined;
  /** Agent source ids, "all", or undefined = config default. */
  agents: string[] | 'all' | undefined;
}

export interface ListOptions {
  limit: number | undefined;
  project: string | undefined;
  agents: string[] | 'all' | undefined;
}

export interface SearchOptions {
  /** Case-insensitive terms; every term must match id, project, or title. */
  query: string[];
  /** Cap the number of matches shown; undefined = all. */
  limit: number | undefined;
  project: string | undefined;
  agents: string[] | 'all' | undefined;
}

export const DEFAULT_MIN_TURNS = 3;

export interface BatchOptions {
  /** Print the work plan and exit without any judge calls. */
  dryRun: boolean;
  force: boolean;
  cache: boolean;
  /** Skip sessions with fewer turns than this. */
  minTurns: number;
  /** Only sessions updated at/after this instant. */
  since: Date | undefined;
  project: string | undefined;
  /** Evaluate at most this many sessions (most recent first). */
  limit: number | undefined;
  metrics: string[] | undefined;
  model: string | undefined;
  agents: string[] | 'all' | undefined;
}

export interface InsightsOptions {
  /** Emit the full computed report as JSON to stdout instead of the view. */
  json: boolean;
  /** Force the one-shot artifact even when stdout is an interactive TTY. */
  static: boolean;
  /** Skip judge tab composition; always render the deterministic tabs. */
  plain: boolean;
  /** Only sessions updated at/after this instant. */
  since: Date | undefined;
  project: string | undefined;
  /** Filter stored sessions to these agents ("all" = no filter). */
  agents: string[] | 'all' | undefined;
}

export type ParsedCli =
  | { command: 'eval'; help: boolean; options: EvalOptions }
  | { command: 'list'; help: boolean; options: ListOptions }
  | { command: 'search'; help: boolean; options: SearchOptions }
  | { command: 'batch'; help: boolean; options: BatchOptions }
  | { command: 'insights'; help: boolean; options: InsightsOptions };

export const USAGE = `agent-evals — evaluate local coding-agent sessions with LLM-judge metrics

Usage
  agent-evals [eval] [options]    evaluate one session (interactive picker unless --session)
  agent-evals list [options]      list sessions with an evaluated? column
  agent-evals search <terms…>     find sessions by title, project, or id
  agent-evals batch [options]     evaluate many sessions idempotently
  agent-evals insights [options]  weekly trends, Agent Leverage composite, hotspots

eval options
  --session, -s <ref>    session uuid or path to a transcript .jsonl
  --agents <ids|all>     agent sources to use (comma-separated: cursor,
                         claude-code, codex; default: [agents].enabled in
                         config.toml, else all available)
  --model, -m <ref>      judge model "provider/model-id" (default: pinned model
                         in config.toml, else auto-picked and pinned)
  --metrics <ids>        run only these metrics (comma-separated ids)
  --limit, -n <n>        max sessions offered in the picker (default: all)
  --force                re-evaluate even when results already exist
  --no-cache             bypass the judge response cache
  --json                 emit the run record JSON to stdout instead of the report

list options
  --limit, -n <n>        max sessions to list (default: all)
  --project <slug>       only sessions from this project
  --agents <ids|all>     agent sources to list (see eval options)

search options
  <terms…>               case-insensitive terms; every term must match the
                         session's title, project, id, or agent
  --limit, -n <n>        cap the number of matches shown (default: all)
  --project <slug>       only sessions from this project
  --agents <ids|all>     agent sources to search (see eval options)

batch options
  --dry-run              print the work plan and exit (no judge calls)
  --force                re-evaluate metric pairs that already have results
  --min-turns <n>        skip sessions with fewer turns (default ${DEFAULT_MIN_TURNS})
  --since <date>         only sessions updated on/after this date (e.g. 2026-08-01)
  --project <slug>       only sessions from this project
  --agents <ids|all>     agent sources to scan (see eval options)
  --limit <n>            evaluate at most n sessions (most recent first)
  --metrics <ids>        run only these metrics (comma-separated ids)
  --model, -m <ref>      judge model "provider/model-id"
  --no-cache             bypass the judge response cache

insights options
  --since <date>         only sessions updated on/after this date (e.g. 2026-08-01)
  --project <slug>       only sessions from this project
  --agents <ids|all>     only stored sessions from these agents ("all" = no filter)
  --static               print the one-shot report instead of the interactive
                         tabs (always used when stdout is not a terminal)
  --plain                skip judge tab composition; deterministic tabs only
                         (config: [insights] compose = false)
  --json                 emit the full computed report as JSON to stdout
                         (includes viewSpec when tabs were composed)

global
  --help, -h             show this help

Files
  ~/.agent-evals/config.toml      provider API keys, pinned judge model, weights
  ~/.agent-evals/agent-evals.db   sessions, metric results, directives
  ~/.agent-evals/cache            cached judge responses (re-runs are free)`;

export function parseCommandLine(argv: readonly string[]): ParsedCli {
  let command: CommandName = 'eval';
  let rest = argv;
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (!(COMMAND_NAMES as readonly string[]).includes(first)) {
      throw new UsageError(
        `unknown command "${first}" (commands: ${COMMAND_NAMES.join(', ')})`,
      );
    }
    command = first as CommandName;
    rest = argv.slice(1);
  }

  switch (command) {
    case 'eval':
      return parseEval(rest);
    case 'list':
      return parseList(rest);
    case 'search':
      return parseSearch(rest);
    case 'batch':
      return parseBatch(rest);
    case 'insights':
      return parseInsights(rest);
  }
}

// ---------------------------------------------------------------------------
// Per-command parsers
// ---------------------------------------------------------------------------

function parseEval(argv: readonly string[]): ParsedCli {
  let help = false;
  const options: EvalOptions = {
    json: false,
    cache: true,
    force: false,
    session: undefined,
    model: undefined,
    limit: undefined,
    metrics: undefined,
    agents: undefined,
  };

  walkFlags(argv, 'eval', (flag, take) => {
    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        return true;
      case '--json':
        options.json = true;
        return true;
      case '--no-cache':
        options.cache = false;
        return true;
      case '--force':
        options.force = true;
        return true;
      case '--session':
      case '-s':
        options.session = take();
        return true;
      case '--model':
      case '-m':
        options.model = take();
        return true;
      case '--limit':
      case '-n':
        options.limit = positiveInt(flag, take());
        return true;
      case '--metrics':
        options.metrics = metricIds(take());
        return true;
      case '--agents':
        options.agents = agentIds(take());
        return true;
      default:
        return false;
    }
  });

  return { command: 'eval', help, options };
}

function parseList(argv: readonly string[]): ParsedCli {
  let help = false;
  const options: ListOptions = { limit: undefined, project: undefined, agents: undefined };

  walkFlags(argv, 'list', (flag, take) => {
    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        return true;
      case '--limit':
      case '-n':
        options.limit = positiveInt(flag, take());
        return true;
      case '--project':
        options.project = take();
        return true;
      case '--agents':
        options.agents = agentIds(take());
        return true;
      default:
        return false;
    }
  });

  return { command: 'list', help, options };
}

function parseSearch(argv: readonly string[]): ParsedCli {
  let help = false;
  const options: SearchOptions = {
    query: [],
    limit: undefined,
    project: undefined,
    agents: undefined,
  };

  walkFlags(
    argv,
    'search',
    (flag, take) => {
      switch (flag) {
        case '--help':
        case '-h':
          help = true;
          return true;
        case '--limit':
        case '-n':
          options.limit = positiveInt(flag, take());
          return true;
        case '--project':
          options.project = take();
          return true;
        case '--agents':
          options.agents = agentIds(take());
          return true;
        default:
          return false;
      }
    },
    (term) => options.query.push(term),
  );

  if (!help && options.query.length === 0) {
    throw new UsageError('search expects at least one query term, e.g. `agent-evals search auth refactor`');
  }
  return { command: 'search', help, options };
}

function parseBatch(argv: readonly string[]): ParsedCli {
  let help = false;
  const options: BatchOptions = {
    dryRun: false,
    force: false,
    cache: true,
    minTurns: DEFAULT_MIN_TURNS,
    since: undefined,
    project: undefined,
    limit: undefined,
    metrics: undefined,
    model: undefined,
    agents: undefined,
  };

  walkFlags(argv, 'batch', (flag, take) => {
    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        return true;
      case '--dry-run':
        options.dryRun = true;
        return true;
      case '--force':
        options.force = true;
        return true;
      case '--no-cache':
        options.cache = false;
        return true;
      case '--min-turns':
        options.minTurns = positiveInt(flag, take());
        return true;
      case '--since':
        options.since = sinceDate(take());
        return true;
      case '--project':
        options.project = take();
        return true;
      case '--limit':
      case '-n':
        options.limit = positiveInt(flag, take());
        return true;
      case '--metrics':
        options.metrics = metricIds(take());
        return true;
      case '--model':
      case '-m':
        options.model = take();
        return true;
      case '--agents':
        options.agents = agentIds(take());
        return true;
      default:
        return false;
    }
  });

  return { command: 'batch', help, options };
}

function parseInsights(argv: readonly string[]): ParsedCli {
  let help = false;
  const options: InsightsOptions = {
    json: false,
    static: false,
    plain: false,
    since: undefined,
    project: undefined,
    agents: undefined,
  };

  walkFlags(argv, 'insights', (flag, take) => {
    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        return true;
      case '--json':
        options.json = true;
        return true;
      case '--static':
        options.static = true;
        return true;
      case '--plain':
        options.plain = true;
        return true;
      case '--since':
        options.since = sinceDate(take());
        return true;
      case '--project':
        options.project = take();
        return true;
      case '--agents':
        options.agents = agentIds(take());
        return true;
      default:
        return false;
    }
  });

  return { command: 'insights', help, options };
}

// ---------------------------------------------------------------------------
// Flag-walking and value parsing helpers
// ---------------------------------------------------------------------------

/**
 * Iterate argv as `--flag[=value]` tokens. `handle` returns false for flags
 * the command does not know, which raises a usage error. Commands that take
 * positional arguments pass `onPositional`; without it, positionals error.
 */
function walkFlags(
  argv: readonly string[],
  command: CommandName,
  handle: (flag: string, take: () => string) => boolean,
  onPositional?: (arg: string) => void,
): void {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      if (onPositional !== undefined) {
        onPositional(arg);
        continue;
      }
      throw new UsageError(`unexpected argument "${arg}" for "agent-evals ${command}"`);
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const take = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${flag} requires a value`);
      i += 1;
      return next;
    };
    if (!handle(flag, take)) {
      throw new UsageError(`unknown option "${arg}" for "agent-evals ${command}"`);
    }
  }
}

function positiveInt(flag: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} expects a positive integer, got "${raw}"`);
  }
  return parsed;
}

function metricIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new UsageError('--metrics expects a comma-separated list of metric ids');
  }
  return ids;
}

/** `--agents` value: the literal "all" or a comma-separated list of agent ids. */
function agentIds(raw: string): string[] | 'all' {
  const trimmed = raw.trim();
  if (trimmed === 'all') return 'all';
  const ids = trimmed
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    throw new UsageError('--agents expects "all" or a comma-separated list of agent ids');
  }
  return ids;
}

function sinceDate(raw: string): Date {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new UsageError(`--since expects a date (e.g. 2026-08-01), got "${raw}"`);
  }
  return new Date(ms);
}
