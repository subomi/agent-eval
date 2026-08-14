/**
 * Shared helpers for the v1 metric library: session/statistics prompt blocks,
 * hand-rolled response parsing (compatible with the judge's `SchemaLike`),
 * and `MetricResult` assembly with turn-reference clamping.
 */

import { renderSession, truncateText, type Session, type SessionStats } from '../model/session.js';
import type { SchemaLike } from '../judge/types.js';
import type { Finding, FindingStatus, MetricResult } from './types.js';

/** Overall char budget for a rendered session inside a judge prompt. */
export const SESSION_CHAR_BUDGET = 40_000;
/** Per tool-payload char budget inside a judge prompt. */
export const TOOL_PAYLOAD_CHAR_BUDGET = 1_200;

export const CODING_SESSION_PREAMBLE =
  'You are evaluating a recorded session between a human user and an autonomous coding agent working in a ' +
  'local repository. The agent edits files, runs terminal commands, searches code, and calls tools. In the ' +
  'transcript below, every turn is labeled "[turn N | user]" or "[turn N | assistant]", tool calls appear as ' +
  '"[tool: Name]" lines (failed ones marked "(failed)"), and tool output as "[result]" lines. Long payloads ' +
  'may carry "…[truncated …]…" markers and very long sessions may omit middle turns.';

// ---------------------------------------------------------------------------
// Prompt building blocks
// ---------------------------------------------------------------------------

export interface SessionBlockOptions {
  maxTotalChars?: number;
  maxToolPayloadChars?: number;
  includeToolResults?: boolean;
}

/** Render the session as a delimited transcript block within a char budget. */
export function buildSessionBlock(session: Session, options: SessionBlockOptions = {}): string {
  const rendered = renderSession(session, {
    maxTotalChars: options.maxTotalChars ?? SESSION_CHAR_BUDGET,
    maxToolPayloadChars: options.maxToolPayloadChars ?? TOOL_PAYLOAD_CHAR_BUDGET,
    includeToolResults: options.includeToolResults ?? true,
  });
  return `--- SESSION TRANSCRIPT ---\n${rendered}\n--- END SESSION TRANSCRIPT ---`;
}

/** Format deterministic session stats for inclusion in a judge prompt. */
export function formatStatsBlock(stats: SessionStats): string {
  const lines: string[] = [
    `- Turns: ${stats.turnCount} total (${stats.userTurnCount} user, ${stats.assistantTurnCount} assistant)`,
    `- Tool calls: ${stats.toolCallCount} total, ${stats.failedToolCallCount} marked failed`,
  ];
  const distribution = Object.entries(stats.toolCallDistribution)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}: ${count}`)
    .join(', ');
  lines.push(`- Tool call distribution: ${distribution.length > 0 ? distribution : '(none)'}`);
  if (stats.repeatedToolCalls.length > 0) {
    lines.push('- Identical (name + input) tool calls issued more than once:');
    for (const repeat of stats.repeatedToolCalls) {
      lines.push(
        `  - ${repeat.name} x${repeat.count} (turns ${repeat.turnIndexes.join(', ')}): ${truncateText(repeat.input, 160)}`,
      );
    }
  } else {
    lines.push('- Identical repeated tool calls: none');
  }
  lines.push(
    `- User turns that look like corrections/steering (conservative keyword heuristic, lower bound): ${stats.userSteeringMessageCount}`,
  );
  return lines.join('\n');
}

/**
 * Build the response-format section of a metric prompt: the JSON shape plus
 * the rules every metric must enforce (JSON only, real turn numbers, 1-3
 * concrete advice strings) and any metric-specific rules.
 */
export function jsonFormatSpec(shape: string, rules: readonly string[]): string {
  const allRules = [
    'Output ONLY one JSON object in exactly this shape. No prose, no markdown, no code fences.',
    'Every turn-number field must be an integer matching a "[turn N | ...]" label from the transcript.',
    '"advice" must contain 1 to 3 strings, most important first. Each must be a concrete, actionable change referencing what actually happened in this session (specific turns, files, commands, or phrasing) — not a platitude.',
    ...rules,
  ];
  return `Required response format:\n${shape}\n\nRules:\n${allRules.map((rule) => `- ${rule}`).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Hand-rolled response parsing (SchemaLike building blocks)
// ---------------------------------------------------------------------------

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  return value;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path}: expected a non-empty string`);
  }
  return value.trim();
}

export function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path}: expected a finite number`);
  }
  return value;
}

export function expectTurnNumber(value: unknown, path: string): number {
  const num = expectNumber(value, path);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`${path}: expected a positive integer turn number`);
  }
  return num;
}

export function optionalTurnNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return expectTurnNumber(value, path);
}

/** Missing/null/blank parses as undefined; anything else must be a string. */
export function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${path}: expected a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function expectEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if ((allowed as readonly string[]).includes(normalized)) return normalized as T;
  }
  throw new Error(`${path}: expected one of ${allowed.join(', ')}`);
}

/** A judge-cited piece of evidence before turnRef clamping. */
export interface RawFinding {
  turn: number;
  /** Short subject (intent / instruction / issue headline), when structured. */
  label?: string;
  /** Verdict on the subject, when structured. */
  status?: FindingStatus;
  note: string;
}

/** Parse a `[{turn, label?, note}]` array; missing/null parses as empty. */
export function parseRawFindings(value: unknown, path: string): RawFinding[] {
  if (value === undefined || value === null) return [];
  return expectArray(value, path).map((item, i) => {
    const record = expectRecord(item, `${path}[${i}]`);
    const finding: RawFinding = {
      turn: expectTurnNumber(record['turn'], `${path}[${i}].turn`),
      note: expectString(record['note'], `${path}[${i}].note`),
    };
    const label = optionalString(record['label'], `${path}[${i}].label`);
    if (label !== undefined) finding.label = label;
    return finding;
  });
}

/** Tag every finding as a generic cited problem (metrics without per-item verdicts). */
export function asIssueFindings(findings: readonly RawFinding[]): RawFinding[] {
  return findings.map((finding) => ({ ...finding, status: 'issue' as const }));
}

/** Parse the advice array; at least one string is required. */
export function parseAdvice(value: unknown, path: string): string[] {
  const items = expectArray(value, path).map((item, i) => expectString(item, `${path}[${i}]`));
  if (items.length === 0) throw new Error(`${path}: expected at least one advice string`);
  return items;
}

/** The common `{score, findings, advice}` judge response. */
export interface ScoredResponse {
  score: number;
  findings: RawFinding[];
  advice: string[];
}

export const scoredResponseSchema: SchemaLike<ScoredResponse> = {
  parse(input: unknown): ScoredResponse {
    const root = expectRecord(input, 'response');
    return {
      score: expectNumber(root['score'], 'score'),
      findings: parseRawFindings(root['findings'], 'findings'),
      advice: parseAdvice(root['advice'], 'advice'),
    };
  },
};

// ---------------------------------------------------------------------------
// MetricResult assembly
// ---------------------------------------------------------------------------

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

export function clampTurnRef(turn: number, turnCount: number): number {
  return Math.min(Math.max(1, Math.round(turn)), Math.max(1, turnCount));
}

export function toFindings(raw: readonly RawFinding[], turnCount: number): Finding[] {
  return raw.map((finding) => {
    const out: Finding = { turnRef: clampTurnRef(finding.turn, turnCount), note: finding.note };
    if (finding.label !== undefined) out.label = finding.label;
    if (finding.status !== undefined) out.status = finding.status;
    return out;
  });
}

/** Trim, dedupe, and cap advice at 3 entries (most important first). */
export function finalizeAdvice(advice: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of advice) {
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length === 3) break;
  }
  return out;
}

export function makeResult(
  score: number,
  findings: readonly RawFinding[],
  advice: readonly string[],
  turnCount: number,
): MetricResult {
  return {
    score: clampScore(score),
    findings: toFindings(findings, turnCount),
    advice: finalizeAdvice(advice),
  };
}
