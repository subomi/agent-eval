/**
 * Single config surface: `~/.agent-evals/config.toml`, parsed with smol-toml.
 *
 * Holds provider API keys (`[providers]`), the pinned judge model
 * (`[judge].model`, written back after the first successful resolution so
 * longitudinal cohorts stay comparable), and composite weights
 * (`[insights.weights]`). The old working-directory `.env.local`/`.env`
 * loader is gone; this file replaces it.
 *
 * Precedence: real environment variables always win over `[providers]`
 * values, so CI / one-off shell overrides keep working. Key values are never
 * logged or printed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

export function agentEvalsHome(): string {
  return join(homedir(), '.agent-evals');
}

export function defaultConfigPath(): string {
  return join(agentEvalsHome(), 'config.toml');
}

export interface AgentEvalsConfig {
  /** Absolute path of the config file backing this object. */
  path: string;
  /** True when the file did not exist and a commented template was written. */
  created: boolean;
  /** Raw `[providers]` entries: lowercase env-var names -> key values. */
  providers: Record<string, string>;
  /** `[judge].model`, the pinned judge model, when set. */
  judgeModel: string | undefined;
  /** `[insights.weights]` per-metric weights, when set. */
  weights: Record<string, number>;
  /** `[insights].compose`: judge-composed insights tabs. Default true. */
  insightsCompose: boolean;
  /**
   * `[agents].enabled`: which session sources commands use when `--agents`
   * is absent. `"all"` (or an unset key) means every available source.
   */
  agentsEnabled: string[] | 'all' | undefined;
}

const CONFIG_TEMPLATE = `# agent-evals configuration — the single config surface.
#
# [providers] holds LLM provider API keys. Key names are the lowercase form
# of the provider env var; real environment variables always take precedence
# over values in this file.
#
# [providers]
# anthropic_api_key = "sk-ant-..."
# openai_api_key = "sk-..."
# gemini_api_key = "..."
# openrouter_api_key = "..."
# xai_api_key = "..."
# groq_api_key = "..."
# mistral_api_key = "..."
# deepseek_api_key = "..."
#
# The judge model is pinned automatically on the first successful run so
# longitudinal scores stay comparable; pass --model to override for one run.
#
# [judge]
# model = "anthropic/claude-sonnet-4-5"
#
# Insights options. compose = false disables the judge-composed interactive
# tabs (one cached judge call per report state; --plain skips it per run).
# [insights.weights] holds optional per-metric weights for the Agent
# Leverage composite; metrics without an entry fall back to built-in
# defaults.
#
# [insights]
# compose = true
#
# [insights.weights]
# goal-completion = 0.25
# tool-efficiency = 0.15
#
# Which agents' sessions commands scan when --agents is absent. "all" (the
# default when unset) means every source whose local store exists.
# Valid ids: cursor, claude-code, codex.
#
# [agents]
# enabled = ["cursor", "claude-code", "codex"]
`;

/**
 * Load the config, writing the commented template first when the file does
 * not exist (`created: true` lets the CLI point the user at it).
 */
export function loadConfig(path: string = defaultConfigPath()): AgentEvalsConfig {
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, CONFIG_TEMPLATE, 'utf8');
    created = true;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const insights = asRecord(parsed['insights']);
  return {
    path,
    created,
    providers: stringRecord(parsed['providers']),
    judgeModel: optionalStringField(asRecord(parsed['judge'])?.['model']),
    weights: numberRecord(insights?.['weights']),
    insightsCompose: insights?.['compose'] !== false,
    agentsEnabled: agentsEnabledField(asRecord(parsed['agents'])?.['enabled'], path),
  };
}

/**
 * Copy `[providers]` keys into `process.env` (uppercased) unless the env var
 * is already set — real environment always wins. Returns the env-var names
 * that were applied (names only; values are never surfaced).
 */
export function applyProviderEnv(config: AgentEvalsConfig): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(config.providers)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(key) || value.length === 0) continue;
    const envName = key.toUpperCase();
    if (process.env[envName] !== undefined) continue;
    process.env[envName] = value;
    applied.push(envName);
  }
  return applied;
}

/**
 * Pin the judge model into `[judge].model` with a minimal textual patch that
 * preserves the file's comments (smol-toml's stringify would drop them):
 * replace an existing uncommented `model =` line inside `[judge]`, else
 * insert one right under the `[judge]` header, else append a new section.
 */
export function pinJudgeModel(config: AgentEvalsConfig, model: string): void {
  const raw = existsSync(config.path) ? readFileSync(config.path, 'utf8') : '';
  const lines = raw.split('\n');
  const modelLine = `model = ${JSON.stringify(model)}`;

  let judgeHeaderIndex = -1;
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header !== null) {
      section = header[1]!.trim();
      if (section === 'judge') judgeHeaderIndex = i;
      continue;
    }
    if (section === 'judge' && /^model\s*=/.test(trimmed)) {
      lines[i] = modelLine;
      writeFileSync(config.path, lines.join('\n'), 'utf8');
      config.judgeModel = model;
      return;
    }
  }

  if (judgeHeaderIndex !== -1) {
    lines.splice(judgeHeaderIndex + 1, 0, modelLine);
    writeFileSync(config.path, lines.join('\n'), 'utf8');
  } else {
    const suffix = raw.endsWith('\n') || raw.length === 0 ? '' : '\n';
    writeFileSync(config.path, `${raw}${suffix}\n[judge]\n${modelLine}\n`, 'utf8');
  }
  config.judgeModel = model;
}

// ---------------------------------------------------------------------------
// TOML value narrowing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const record = asRecord(value);
  if (record === undefined) return out;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const record = asRecord(value);
  if (record === undefined) return out;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** `[agents].enabled`: `"all"` or an array of agent-id strings. */
function agentsEnabledField(value: unknown, path: string): string[] | 'all' | undefined {
  if (value === undefined) return undefined;
  if (value === 'all') return 'all';
  if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) {
    const ids = value.map((v) => v.trim()).filter((v) => v.length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  throw new Error(`[agents].enabled in ${path} must be "all" or an array of agent ids`);
}
