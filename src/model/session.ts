/**
 * Normalized session model shared by all session sources (adapters), metrics,
 * and the judge layer, plus deterministic derived stats and long-session
 * utilities (payload truncation, compact rendering for judge prompts).
 */

export type Role = 'user' | 'assistant';

export interface ToolCall {
  /** Tool name as reported by the agent transcript, e.g. "Shell", "Read". */
  name: string;
  /** Tool input as parsed from the transcript (JSON-serializable). */
  input: unknown;
  /** Tool result payload in text form, when the transcript records one. */
  result?: string;
  /** True when the transcript marked this call as failed/errored. */
  isError?: boolean;
}

export interface Turn {
  /** 1-based position within the session. Used for citations (`turnRef`). */
  index: number;
  role: Role;
  /** Concatenated visible text content of the turn (may be empty). */
  text: string;
  toolCalls: ToolCall[];
}

export interface Session {
  id: string;
  /** Which agent produced the session, e.g. "cursor". */
  agent: string;
  /** Project name or slug the session belongs to. */
  project: string;
  title: string;
  updatedAt: Date;
  turns: Turn[];
}

// ---------------------------------------------------------------------------
// Derived deterministic stats
// ---------------------------------------------------------------------------

export interface RepeatedToolCall {
  name: string;
  /** Canonical (key-sorted) JSON of the input shared by all occurrences. */
  input: string;
  /** Total occurrences (always >= 2). */
  count: number;
  /** Turn index of each occurrence, in order (may repeat within a turn). */
  turnIndexes: number[];
}

export interface SessionStats {
  turnCount: number;
  userTurnCount: number;
  assistantTurnCount: number;
  toolCallCount: number;
  /** Tool name -> number of invocations. */
  toolCallDistribution: Record<string, number>;
  /** Identical (name + input) tool calls issued more than once. */
  repeatedToolCalls: RepeatedToolCall[];
  /** Tool calls whose transcript marked them as errored. */
  failedToolCallCount: number;
  /**
   * User turns after the first that look like steering/corrections, detected
   * with a conservative keyword heuristic. Treat as a lower-bound signal;
   * judge-based metrics should confirm.
   */
  userSteeringMessageCount: number;
}

const STEERING_PATTERNS: readonly RegExp[] = [
  /\bnot? (what|that|this|correct|right|like that)\b/i,
  /\b(wrong|incorrect|mistake)\b/i,
  /\binstead\b/i,
  /\bactually\b/i,
  /\bdon'?t\b/i,
  /\bstop\b/i,
  /\b(undo|revert|roll back|go back)\b/i,
  /\bwait\b/i,
  /\bi meant\b/i,
  /\bwhy (did|are) you\b/i,
  /\b(redo|try again|start over)\b/i,
  /\bthat'?s not\b/i,
  /\byou (missed|forgot|broke|ignored)\b/i,
];

export function computeSessionStats(session: Session): SessionStats {
  const distribution: Record<string, number> = {};
  const byInput = new Map<string, { name: string; input: string; turnIndexes: number[] }>();
  let toolCallCount = 0;
  let failedToolCallCount = 0;
  let userTurnCount = 0;
  let assistantTurnCount = 0;
  let userSteeringMessageCount = 0;
  let firstUserTurnSeen = false;

  for (const turn of session.turns) {
    if (turn.role === 'user') {
      userTurnCount += 1;
      if (firstUserTurnSeen && STEERING_PATTERNS.some((p) => p.test(turn.text))) {
        userSteeringMessageCount += 1;
      }
      firstUserTurnSeen = true;
    } else {
      assistantTurnCount += 1;
    }

    for (const call of turn.toolCalls) {
      toolCallCount += 1;
      distribution[call.name] = (distribution[call.name] ?? 0) + 1;
      if (call.isError) failedToolCallCount += 1;

      const canonicalInput = stableStringify(call.input);
      const key = `${call.name}\u0000${canonicalInput}`;
      const entry = byInput.get(key);
      if (entry) {
        entry.turnIndexes.push(turn.index);
      } else {
        byInput.set(key, { name: call.name, input: canonicalInput, turnIndexes: [turn.index] });
      }
    }
  }

  const repeatedToolCalls: RepeatedToolCall[] = [];
  for (const entry of byInput.values()) {
    if (entry.turnIndexes.length > 1) {
      repeatedToolCalls.push({
        name: entry.name,
        input: entry.input,
        count: entry.turnIndexes.length,
        turnIndexes: entry.turnIndexes,
      });
    }
  }

  return {
    turnCount: session.turns.length,
    userTurnCount,
    assistantTurnCount,
    toolCallCount,
    toolCallDistribution: distribution,
    repeatedToolCalls,
    failedToolCallCount,
    userSteeringMessageCount,
  };
}

/** JSON.stringify with recursively sorted object keys, for stable dedup/cache keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'undefined';
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortValue(source[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Long-session handling: truncation and compact rendering for judge prompts
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOOL_PAYLOAD_CHARS = 2000;

/**
 * Truncate a string to roughly `maxChars`, keeping the head and tail (tool
 * output tails often carry the error/result that matters) with an omission
 * marker in between. The result may exceed `maxChars` by the marker length.
 */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.7);
  const tail = maxChars - head;
  const marker = ` …[truncated ${text.length - maxChars} chars]… `;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '');
}

/**
 * Return a copy of the session with every tool payload capped at
 * `maxToolPayloadChars`. Oversized tool inputs are replaced by their
 * truncated canonical-JSON string; results are truncated in place.
 */
export function truncateToolPayloads(
  session: Session,
  maxToolPayloadChars: number = DEFAULT_MAX_TOOL_PAYLOAD_CHARS,
): Session {
  return {
    ...session,
    turns: session.turns.map((turn) => ({
      ...turn,
      toolCalls: turn.toolCalls.map((call) => {
        const serialized = stableStringify(call.input);
        const next: ToolCall = {
          ...call,
          input:
            serialized.length > maxToolPayloadChars
              ? truncateText(serialized, maxToolPayloadChars)
              : call.input,
        };
        if (call.result !== undefined) {
          next.result = truncateText(call.result, maxToolPayloadChars);
        }
        return next;
      }),
    })),
  };
}

export interface RenderOptions {
  /** Per-payload char budget applied while rendering. Default 2000. */
  maxToolPayloadChars?: number;
  /** Include tool results in the rendering. Default true. */
  includeToolResults?: boolean;
  /**
   * Optional overall char budget for the rendered output. When exceeded,
   * leading and trailing turns are kept and the middle is elided with a
   * `[... N turns omitted ...]` marker.
   */
  maxTotalChars?: number;
}

/**
 * Render a full session to compact text for inclusion in a judge prompt.
 * Every turn is labeled `[turn N | role]` so judges can cite turn numbers.
 */
export function renderSession(session: Session, options: RenderOptions = {}): string {
  const header = `Session "${session.title}" (project: ${session.project}, agent: ${session.agent}, ${session.turns.length} turns)`;
  const body = renderTurnBlocks(session.turns, options);
  return `${header}\n\n${body}`;
}

/**
 * Render an inclusive window of turns (1-based indexes into `Turn.index`).
 * Useful for per-metric windowing over very long sessions.
 */
export function renderTurnWindow(
  session: Session,
  startTurn: number,
  endTurn: number,
  options: RenderOptions = {},
): string {
  const turns = session.turns.filter((t) => t.index >= startTurn && t.index <= endTurn);
  return renderTurnBlocks(turns, options);
}

/** Render a single turn with its `[turn N | role]` citation label. */
export function renderTurn(turn: Turn, options: RenderOptions = {}): string {
  const maxPayload = options.maxToolPayloadChars ?? DEFAULT_MAX_TOOL_PAYLOAD_CHARS;
  const includeResults = options.includeToolResults ?? true;

  const lines: string[] = [`[turn ${turn.index} | ${turn.role}]`];
  if (turn.text.trim().length > 0) {
    lines.push(turn.text.trim());
  }
  for (const call of turn.toolCalls) {
    const input = truncateText(
      typeof call.input === 'string' ? call.input : stableStringify(call.input),
      maxPayload,
    );
    lines.push(`  [tool: ${call.name}]${call.isError ? ' (failed)' : ''} ${input}`);
    if (includeResults && call.result !== undefined) {
      lines.push(`  [result] ${truncateText(call.result, maxPayload)}`);
    }
  }
  return lines.join('\n');
}

function renderTurnBlocks(turns: readonly Turn[], options: RenderOptions): string {
  const blocks = turns.map((turn) => renderTurn(turn, options));
  const budget = options.maxTotalChars;
  if (budget === undefined) return blocks.join('\n\n');

  // Cap any single block so one giant turn cannot consume the whole budget.
  const perBlockCap = Math.max(1, Math.floor(budget / 2));
  const capped = blocks.map((b) => truncateText(b, perBlockCap));

  const separatorLen = 2; // "\n\n"
  const total = capped.reduce((sum, b) => sum + b.length + separatorLen, 0);
  if (total <= budget) return capped.join('\n\n');

  // Keep leading turns up to ~half the budget, then trailing turns for the rest.
  const leading: string[] = [];
  let used = 0;
  let front = 0;
  while (front < capped.length) {
    const block = capped[front]!;
    if (used + block.length + separatorLen > budget / 2) break;
    leading.push(block);
    used += block.length + separatorLen;
    front += 1;
  }

  const trailing: string[] = [];
  let back = capped.length - 1;
  while (back >= front) {
    const block = capped[back]!;
    if (used + block.length + separatorLen > budget) break;
    trailing.unshift(block);
    used += block.length + separatorLen;
    back -= 1;
  }

  const omitted = back - front + 1;
  if (omitted <= 0) return [...leading, ...trailing].join('\n\n');
  return [...leading, `[... ${omitted} turns omitted ...]`, ...trailing].join('\n\n');
}
