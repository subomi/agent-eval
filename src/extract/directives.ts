/**
 * Directive extraction: NOT a scored metric. A pure per-session judge pass
 * that extracts durable user directives worth remembering across sessions —
 * standing instructions ("always use pnpm"), preferences ("don't add
 * comments"), and corrections of agent behavior that imply a standing rule.
 * One-off task instructions ("fix this bug") are explicitly excluded.
 *
 * This module does no persistence; a later phase runs it inside the pipeline
 * and stores results in SQLite keyed by `DIRECTIVE_EXTRACTOR_VERSION`.
 */

import type { Session } from '../model/session.js';
import type { Judge, SchemaLike } from '../judge/types.js';
import {
  CODING_SESSION_PREAMBLE,
  buildSessionBlock,
  clampTurnRef,
  expectArray,
  expectEnum,
  expectRecord,
  expectString,
  expectTurnNumber,
} from '../metrics/shared.js';

/** Bumped whenever the extraction methodology changes. Persisted with rows. */
export const DIRECTIVE_EXTRACTOR_VERSION = 1;

const DIRECTIVE_KINDS = ['instruction', 'preference', 'correction'] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];

export interface ExtractedDirective {
  /** 1-based turn index where the user stated (or most clearly implied) it. */
  turnRef: number;
  kind: DirectiveKind;
  /** Short canonical restatement of the directive, suitable for cross-session clustering. */
  text: string;
}

interface DirectivesResponse {
  directives: ExtractedDirective[];
}

const responseSchema: SchemaLike<DirectivesResponse> = {
  parse(input: unknown): DirectivesResponse {
    const root = expectRecord(input, 'response');
    const raw = root['directives'];
    const directives =
      raw === undefined || raw === null
        ? []
        : expectArray(raw, 'directives').map((item, i): ExtractedDirective => {
            const record = expectRecord(item, `directives[${i}]`);
            return {
              turnRef: expectTurnNumber(record['turn'], `directives[${i}].turn`),
              kind: expectEnum(record['kind'], `directives[${i}].kind`, DIRECTIVE_KINDS),
              text: expectString(record['text'], `directives[${i}].text`),
            };
          });
    return { directives };
  },
};

function buildPrompt(session: Session): string {
  return [
    CODING_SESSION_PREAMBLE,
    'Task: DIRECTIVE EXTRACTION — extract the durable directives the USER gave in this session: rules worth remembering and applying in FUTURE sessions. This is an extraction pass, not an evaluation; do not judge whether the agent obeyed them.',
    [
      'Extract only directives that pass the durability test: would this still apply to a future, different task? Classify each as:',
      '- "instruction": a standing operational rule — "always use pnpm", "never commit without asking", "run the typecheck before finishing".',
      '- "preference": a standing style or taste rule — "don\'t add code comments", "prefer named exports", "keep explanations short".',
      '- "correction": the user corrected agent behavior in a way that implies a standing rule (especially if repeated) — e.g. the user twice tells the agent to stop apologizing; restate it as the rule the user evidently wants going forward.',
      'NOT directives (exclude): the task goal itself and one-off task instructions ("fix this bug", "rename this function"), scope limits that only apply to the current change ("leave the README out of this PR"), answers to agent questions, approvals, and anything the user later revoked.',
      'For each directive, "text" is a short, self-contained canonical restatement in the imperative, faithful to the user\'s intent and keeping concrete specifics (tool names, commands, paths, phrasing) — it will be clustered with directives from other sessions, so it must be understandable without this transcript. "turn" is the user turn where it was stated, or for repeated corrections the clearest occurrence.',
      'Most sessions contain zero or a few durable directives. If there are none, return an empty "directives" array — do NOT invent directives from ordinary task instructions.',
    ].join('\n'),
    `Required response format:
{
  "directives": [ { "turn": number, "kind": "instruction" | "preference" | "correction", "text": string } ]
}

Rules:
- Output ONLY one JSON object in exactly this shape. No prose, no markdown, no code fences.
- Every "turn" must be an integer matching a "[turn N | user]" label from the transcript.
- Each "text" must be one sentence, at most ~20 words.
- Do not emit near-duplicate directives; merge restatements of the same rule into one entry.`,
    buildSessionBlock(session),
  ].join('\n\n');
}

/**
 * Extract durable user directives from a session via one judge call.
 * Returns an empty array for sessions with none. Turn refs are clamped to
 * the session's turn range; duplicate texts are collapsed.
 */
export async function extractDirectives(
  session: Session,
  judge: Judge,
): Promise<ExtractedDirective[]> {
  const response = await judge.evaluate({ prompt: buildPrompt(session), schema: responseSchema });
  const seen = new Set<string>();
  const out: ExtractedDirective[] = [];
  for (const directive of response.directives) {
    const key = directive.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      turnRef: clampTurnRef(directive.turnRef, session.turns.length),
      kind: directive.kind,
      text: directive.text,
    });
  }
  return out;
}
