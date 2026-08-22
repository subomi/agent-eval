/**
 * Helpers shared by the eval/list/batch/insights commands: config-backed
 * judge setup (provider keys from config.toml, model pinning), metric
 * selection, and agent-source resolution (`--agents` flag over
 * `[agents].enabled` config over "all available").
 */

import {
  allSourceIds,
  availableSources,
  sourceById,
  type ListSessionsOptions,
  type SessionMeta,
  type SessionSource,
} from '../../adapters/index.js';
import { createJudge, type CreateJudgeOptions, type PiJudge } from '../../judge/index.js';
import { allMetrics, type Metric } from '../../metrics/index.js';
import type { Session } from '../../model/session.js';
import {
  applyProviderEnv,
  loadConfig,
  pinJudgeModel,
  type AgentEvalsConfig,
} from '../../store/config.js';
import { openDb } from '../../store/db.js';
import { UsageError } from '../args.js';
import { relativeAge } from '../format.js';
import type { SessionListRow } from '../ui/SessionTable.js';

/** Load config.toml, printing the first-run notice when the template was written. */
export function loadConfigWithNotice(): AgentEvalsConfig {
  const config = loadConfig();
  if (config.created) {
    console.error(
      `agent-evals: created ${config.path} — put your provider API key there ([providers] section).`,
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// Agent-source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the active session sources: `--agents` flag > `[agents].enabled`
 * in config.toml > "all". "all" means every source whose local store exists;
 * explicit ids are used as given (an id with a missing store simply lists
 * nothing). Unknown ids error with the valid list.
 */
export function resolveSources(
  flagAgents: string[] | 'all' | undefined,
  config: AgentEvalsConfig,
): SessionSource[] {
  const requested = flagAgents ?? config.agentsEnabled ?? 'all';
  if (requested === 'all') {
    const available = availableSources();
    if (available.length === 0) {
      throw new Error(
        `no agent session stores found on this machine (known agents: ${allSourceIds.join(', ')})`,
      );
    }
    return available;
  }
  const origin = flagAgents !== undefined ? '--agents' : `[agents].enabled in ${config.path}`;
  return validateAgentIds(requested, origin).map((id) => sourceById(id)!);
}

/**
 * Insights variant: resolve to a DB filter on `sessions.agent`. "all" (or
 * nothing configured) means no filter — the DB may hold sessions from
 * agents whose stores no longer exist.
 */
export function resolveAgentFilter(
  flagAgents: string[] | 'all' | undefined,
  config: AgentEvalsConfig,
): string[] | undefined {
  const requested = flagAgents ?? config.agentsEnabled ?? 'all';
  if (requested === 'all') return undefined;
  const origin = flagAgents !== undefined ? '--agents' : `[agents].enabled in ${config.path}`;
  return validateAgentIds(requested, origin);
}

function validateAgentIds(ids: readonly string[], origin: string): string[] {
  const unique = [...new Set(ids)];
  const unknown = unique.filter((id) => sourceById(id) === undefined);
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'unknown agent id' : 'unknown agent ids';
    throw new UsageError(
      `${label} ${unknown.map((id) => `"${id}"`).join(', ')} in ${origin}. ` +
        `Valid ids: ${allSourceIds.join(', ')}`,
    );
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Cross-source listing and session resolution
// ---------------------------------------------------------------------------

/** Merge listings from all active sources, newest first, then apply the limit. */
export async function listSessionsAcrossSources(
  sources: readonly SessionSource[],
  options: ListSessionsOptions = {},
): Promise<SessionMeta[]> {
  const lists = await Promise.all(sources.map((source) => source.listSessions(options)));
  const merged = lists.flat();
  merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return options.limit !== undefined ? merged.slice(0, options.limit) : merged;
}

/**
 * Build `SessionTable` rows for a set of metas: load each transcript for the
 * real turn count and count evaluated metrics from the DB. Unreadable
 * transcripts keep their row with a "?" turn count.
 */
export async function buildSessionRows(
  metas: readonly SessionMeta[],
): Promise<SessionListRow[]> {
  const db = openDb();
  try {
    return await Promise.all(
      metas.map(async (meta): Promise<SessionListRow> => {
        let turns = '?';
        let evaluatedMetrics = 0;
        try {
          const session = await sourceById(meta.agent)!.loadSession(meta);
          turns = String(session.turns.length);
          evaluatedMetrics = db.countEvaluatedMetrics(session.contentHash);
        } catch {
          // unreadable transcript; keep the row with unknown turn count
        }
        return {
          id: meta.id,
          agent: meta.agent,
          age: relativeAge(meta.updatedAt),
          turns,
          evaluatedMetrics,
          project: meta.project,
          title: meta.title,
        };
      }),
    );
  } finally {
    db.close();
  }
}

/**
 * Resolve a `--session` ref (uuid or transcript path) across the active
 * sources. Sources that mis-parse a foreign transcript yield zero turns, so
 * non-empty matches take precedence; a ref that genuinely matches multiple
 * sources errors and asks for `--agents`.
 */
export async function resolveSessionAcrossSources(
  ref: string,
  sources: readonly SessionSource[],
): Promise<Session> {
  const matches: Session[] = [];
  const failures: string[] = [];
  for (const source of sources) {
    try {
      matches.push(await source.loadSession(ref));
    } catch (error) {
      failures.push(`${source.id}: ${errorMessage(error)}`);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `session "${ref}" not found in any active source\n  ${failures.join('\n  ')}`,
    );
  }
  const nonEmpty = matches.filter((s) => s.turns.length > 0);
  const candidates = nonEmpty.length > 0 ? nonEmpty : matches;
  if (candidates.length > 1) {
    throw new Error(
      `session "${ref}" matches sessions in multiple sources ` +
        `(${candidates.map((s) => s.agent).join(', ')}); disambiguate with --agents <id>`,
    );
  }
  return candidates[0]!;
}

function providerKeyHint(configPath: string): string {
  return [
    `No LLM provider API key found. Add one to ${configPath} under [providers], e.g.`,
    '',
    '  [providers]',
    '  anthropic_api_key = "sk-ant-..."',
    '',
    'Supported keys: anthropic_api_key, openai_api_key, gemini_api_key,',
    'openrouter_api_key, xai_api_key, groq_api_key, mistral_api_key, deepseek_api_key.',
    'Real environment variables (ANTHROPIC_API_KEY, ...) take precedence over config values.',
    '',
    'Alternatively pass --model "<provider>/<model-id>" to pick a specific model.',
  ].join('\n');
}

export interface JudgeSetup {
  judge: PiJudge;
  /** Resolved judge model, `"provider/model-id"` — the idempotency-key part. */
  modelRef: string;
  config: AgentEvalsConfig;
}

/**
 * Apply `[providers]` keys to the environment (env always wins) and resolve
 * the judge model: `--model` flag > pinned `[judge].model` > auto-pick. An
 * auto-picked model is pinned back into config.toml so longitudinal cohorts
 * stay comparable. Pass a preloaded `config` to avoid re-reading the file.
 */
export async function setupJudge(opts: {
  model: string | undefined;
  cache: boolean;
  config?: AgentEvalsConfig;
}): Promise<JudgeSetup> {
  const config = opts.config ?? loadConfigWithNotice();
  applyProviderEnv(config);

  const explicit = opts.model ?? config.judgeModel;
  const judgeOptions: CreateJudgeOptions = { cache: opts.cache };
  if (explicit !== undefined) judgeOptions.model = explicit;
  const judge = createJudge(judgeOptions);

  let modelRef: string;
  try {
    modelRef = await judge.modelRef();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('No LLM provider')) {
      throw new Error(`no judge model available.\n\n${providerKeyHint(config.path)}`);
    }
    throw error;
  }

  if (opts.model === undefined && config.judgeModel === undefined) {
    pinJudgeModel(config, modelRef);
    console.error(`agent-evals: pinned judge model ${modelRef} in ${config.path}`);
  }

  return { judge, modelRef, config };
}

/** Resolve `--metrics` ids against the registry, preserving canonical run order. */
export function selectMetrics(ids: readonly string[] | undefined): Metric[] {
  if (ids === undefined) return allMetrics;
  const known = new Set(allMetrics.map((m) => m.id));
  const unknown = [...new Set(ids.filter((id) => !known.has(id)))];
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'unknown metric id' : 'unknown metric ids';
    throw new UsageError(
      `${label} ${unknown.map((id) => `"${id}"`).join(', ')}. ` +
        `Valid ids: ${allMetrics.map((m) => m.id).join(', ')}`,
    );
  }
  const wanted = new Set(ids);
  return allMetrics.filter((m) => wanted.has(m.id));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
