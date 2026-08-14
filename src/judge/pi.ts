/**
 * LLM-judge implementation on `@earendil-works/pi-ai`.
 *
 * - Model selection: explicit `"provider/model-id"` string in config, else
 *   auto-picked from providers with configured auth (`models.getAvailable()`)
 *   using a quality-ordered preference list.
 * - Structured output: pi-ai has no JSON-constrained decoding for plain text
 *   responses, so the judge instructs the model to emit only JSON, extracts it
 *   robustly (code fences, first/last bracket), validates via the caller's
 *   `SchemaLike`, and retries once with the parse error appended.
 * - Disk cache under `~/.agent-evals/cache/` keyed by
 *   sha256(model + prompt + schema identifier).
 * - Bounded concurrency via an internal promise pool (default 4).
 */

import {
  parseJsonWithRepair,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type TextContent,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { stableStringify } from '../model/session.js';
import { DiskCache, judgeCacheKey } from './cache.js';
import { PromisePool } from './pool.js';
import type { Judge, JudgeConfig, JudgeInput } from './types.js';

export const DEFAULT_JUDGE_CONCURRENCY = 4;

const JUDGE_SYSTEM_PROMPT =
  'You are a meticulous evaluation judge for recorded coding-agent sessions. ' +
  'You ground every judgement in transcript evidence and cite turn numbers. ' +
  'You always respond with a single JSON value and nothing else: no prose, no markdown, no code fences.';

/**
 * Auto-pick preference order, matched against `"provider/model-id"`. Within a
 * matching group the newest model (numeric-aware id sort) wins. Roughly:
 * frontier Anthropic/OpenAI models first, then Google, then the rest.
 */
const MODEL_PREFERENCES: readonly RegExp[] = [
  /^anthropic\/claude-sonnet/,
  /^anthropic\/claude-opus/,
  /^openai\/gpt-5(\.\d+)?$/,
  /^anthropic\/claude/,
  /^openai\/gpt-5/,
  /^openai\//,
  /^google\/gemini[^/]*-pro/,
  /^google\//,
  /^xai\//,
  /^mistral\//,
  /^deepseek\//,
  /^groq\//,
  /^openrouter\//,
];

/**
 * Resolve the judge model. `explicit` accepts `"provider/model-id"` (e.g.
 * `"anthropic/claude-sonnet-4-5"`) or a bare model id unique across
 * providers. Without it, picks the best model among providers that have
 * auth configured (API key in env, stored credential, ...).
 */
export async function pickJudgeModel(models: Models, explicit?: string): Promise<Model<Api>> {
  if (explicit !== undefined) {
    const found = findExplicitModel(models, explicit);
    if (!found) {
      throw new Error(
        `Unknown judge model "${explicit}". Expected "<provider>/<model-id>" (e.g. "anthropic/claude-sonnet-4-5") or a bare model id from the pi-ai catalog.`,
      );
    }
    return found;
  }

  const available = await models.getAvailable();
  if (available.length === 0) {
    throw new Error(
      'No LLM provider is configured. Set an API key in the environment (e.g. ANTHROPIC_API_KEY, ' +
        'OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY) or pass an explicit judge model.',
    );
  }

  for (const preference of MODEL_PREFERENCES) {
    const candidates = available.filter((m) => preference.test(`${m.provider}/${m.id}`));
    const best = newestById(candidates);
    if (best) return best;
  }
  // No preferred provider available: fall back to the largest context window.
  return [...available].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0]!;
}

function findExplicitModel(models: Models, ref: string): Model<Api> | undefined {
  const slash = ref.indexOf('/');
  if (slash > 0) {
    const byProvider = models.getModel(ref.slice(0, slash), ref.slice(slash + 1));
    if (byProvider) return byProvider;
  }
  // Bare id, or an id that itself contains "/" (e.g. openrouter models).
  return models.getModels().find((m) => m.id === ref || `${m.provider}/${m.id}` === ref);
}

function newestById(candidates: readonly Model<Api>[]): Model<Api> | undefined {
  return [...candidates].sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
}

/**
 * Extract the JSON payload from a model response: prefers a fenced
 * ```json``` block when present, otherwise slices from the first `{`/`[` to
 * the last matching `}`/`]`.
 */
export function extractJsonText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const brace = body.indexOf('{');
  const bracket = body.indexOf('[');
  const start = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket);
  if (start === -1) throw new Error('response contains no JSON object or array');
  const closer = body[start] === '{' ? '}' : ']';
  const end = body.lastIndexOf(closer);
  if (end <= start) throw new Error('response contains an unterminated JSON value');
  return body.slice(start, end + 1);
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return parseJsonWithRepair(text);
  }
}

function textContentOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildUserPrompt<T>(input: JudgeInput<T>): string {
  const parts = [input.prompt];
  if (input.jsonSchema) {
    parts.push(`Your JSON response MUST conform to this JSON Schema:\n${JSON.stringify(input.jsonSchema)}`);
  }
  parts.push('Final reminder: output ONLY the JSON value itself. No explanations, no markdown, no code fences.');
  return parts.join('\n\n');
}

export interface CreateJudgeOptions extends JudgeConfig {
  /** Cache directory override. Default: `~/.agent-evals/cache`. */
  cacheDir?: string;
  /** Injected pi-ai Models collection (tests). Default: `builtinModels()`. */
  models?: Models;
}

export class PiJudge implements Judge {
  private readonly pool: PromisePool;
  private readonly cache: DiskCache | undefined;
  private readonly explicitModel: string | undefined;
  private readonly temperature: number | undefined;
  private readonly injectedModels: Models | undefined;
  private modelsInstance: Models | undefined;
  private modelPromise: Promise<Model<Api>> | undefined;

  constructor(options: CreateJudgeOptions = {}) {
    this.pool = new PromisePool(options.concurrency ?? DEFAULT_JUDGE_CONCURRENCY);
    this.cache = (options.cache ?? true) ? new DiskCache(options.cacheDir) : undefined;
    this.explicitModel = options.model;
    this.temperature = options.temperature;
    this.injectedModels = options.models;
  }

  async evaluate<T>(input: JudgeInput<T>): Promise<T> {
    return this.pool.run(() => this.evaluateNow(input));
  }

  /** `"provider/model-id"` of the resolved judge model (resolving it if needed). */
  async modelRef(): Promise<string> {
    const model = await this.resolveModel();
    return `${model.provider}/${model.id}`;
  }

  private models(): Models {
    if (this.injectedModels) return this.injectedModels;
    this.modelsInstance ??= builtinModels();
    return this.modelsInstance;
  }

  private resolveModel(): Promise<Model<Api>> {
    this.modelPromise ??= pickJudgeModel(this.models(), this.explicitModel);
    return this.modelPromise;
  }

  private async evaluateNow<T>(input: JudgeInput<T>): Promise<T> {
    const model = await this.resolveModel();
    const modelRef = `${model.provider}/${model.id}`;
    const schemaId = input.jsonSchema ? stableStringify(input.jsonSchema) : '';
    const key = judgeCacheKey([modelRef, input.prompt, schemaId]);

    if (this.cache) {
      const hit = await this.cache.get(key);
      if (hit !== undefined) {
        try {
          return input.schema.parse(parseJsonLoose(hit));
        } catch {
          // Stale or schema-incompatible entry: fall through to a fresh call.
        }
      }
    }

    const context: Context = {
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(input), timestamp: Date.now() }],
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const message = await this.request(model, context);
      try {
        const jsonText = extractJsonText(textContentOf(message));
        const parsed = input.schema.parse(parseJsonLoose(jsonText));
        if (this.cache) await this.cache.set(key, jsonText, { model: modelRef });
        return parsed;
      } catch (error) {
        lastError = error;
        context.messages.push(message);
        context.messages.push({
          role: 'user',
          content:
            `Your previous response could not be used: ${errorText(error)}\n` +
            'Respond again with ONLY the requested JSON value, fixing that problem. No prose, no code fences.',
          timestamp: Date.now(),
        });
      }
    }
    throw new Error(`Judge model ${modelRef} returned unusable output after a retry: ${errorText(lastError)}`);
  }

  private async request(model: Model<Api>, context: Context): Promise<AssistantMessage> {
    const options: { temperature?: number } = {};
    if (this.temperature !== undefined) options.temperature = this.temperature;
    const message = await this.models().complete(model, context, options);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw new Error(
        `Judge request to ${model.provider}/${model.id} failed: ${message.errorMessage ?? message.stopReason}`,
      );
    }
    return message;
  }
}

export function createJudge(options: CreateJudgeOptions = {}): PiJudge {
  return new PiJudge(options);
}
