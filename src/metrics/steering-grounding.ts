/**
 * Steering Grounding (target: user). The judge identifies steering episodes
 * (user turns that correct or redirect the agent), classifies each steer as
 * grounded (backed by evidence: code, errors, docs, concrete observations) /
 * vague (redirection without substance) / misleading (confidently wrong and
 * derailing), and classifies the user's overall interaction mode as
 * augmentative (engaged, verifying, steering with evidence) vs delegative
 * (passive acceptance without examination).
 *
 * Score (computed in code from the judge's classifications):
 * - No steers: 1.0 if the mode is augmentative (well-examined acceptance),
 *   0.45 if delegative (pure unexamined acceptance is not a win).
 * - With steers: mean of per-steer points (grounded 1, vague 0.4,
 *   misleading 0), minus 0.1 per consecutive ungrounded->ungrounded pair
 *   (chain penalty, capped at 0.3), minus 0.15 if the mode is delegative.
 *
 * Findings map onto existing statuses: grounded -> 'satisfied', vague ->
 * 'unclear', misleading -> 'violated'; a delegative mode adds one 'issue'
 * finding. `computeSessionStats(...).userSteeringMessageCount` is fed to the
 * judge as a conservative keyword-based lower bound on steering turns.
 */

import { computeSessionStats, type Session, type SessionStats } from '../model/session.js';
import type { Judge, SchemaLike } from '../judge/types.js';
import type { FindingStatus, Metric, MetricResult } from './types.js';
import {
  CODING_SESSION_PREAMBLE,
  buildSessionBlock,
  clampScore,
  expectArray,
  expectEnum,
  expectRecord,
  expectString,
  expectTurnNumber,
  formatStatsBlock,
  jsonFormatSpec,
  makeResult,
  parseAdvice,
  type RawFinding,
} from './shared.js';

const GROUNDINGS = ['grounded', 'vague', 'misleading'] as const;
type Grounding = (typeof GROUNDINGS)[number];

const MODES = ['augmentative', 'delegative'] as const;
type InteractionMode = (typeof MODES)[number];

interface JudgedSteer {
  turn: number;
  subject: string;
  grounding: Grounding;
  note: string;
}

interface SteeringGroundingResponse {
  steers: JudgedSteer[];
  mode: InteractionMode;
  modeTurn: number;
  modeNote: string;
  advice: string[];
}

const responseSchema: SchemaLike<SteeringGroundingResponse> = {
  parse(input: unknown): SteeringGroundingResponse {
    const root = expectRecord(input, 'response');
    const rawSteers = root['steers'];
    const steers =
      rawSteers === undefined || rawSteers === null
        ? []
        : expectArray(rawSteers, 'steers').map((item, i): JudgedSteer => {
            const record = expectRecord(item, `steers[${i}]`);
            return {
              turn: expectTurnNumber(record['turn'], `steers[${i}].turn`),
              subject: expectString(record['subject'], `steers[${i}].subject`),
              grounding: expectEnum(record['grounding'], `steers[${i}].grounding`, GROUNDINGS),
              note: expectString(record['note'], `steers[${i}].note`),
            };
          });
    return {
      steers,
      mode: expectEnum(root['mode'], 'mode', MODES),
      modeTurn: expectTurnNumber(root['modeTurn'], 'modeTurn'),
      modeNote: expectString(root['modeNote'], 'modeNote'),
      advice: parseAdvice(root['advice'], 'advice'),
    };
  },
};

function buildPrompt(session: Session, stats: SessionStats): string {
  return [
    CODING_SESSION_PREAMBLE,
    'Metric: STEERING GROUNDING — when the USER corrected or redirected the agent, was the steering grounded in evidence, and was the user engaged with the work at all?',
    `Deterministic session statistics:\n${formatStatsBlock(stats)}\n\nThe "corrections/steering" count above comes from a conservative keyword heuristic — treat it as a lower bound on steering turns, not the truth. You will usually find at least that many steering episodes, often more; you may also find fewer if the keywords fired on non-steering text.`,
    [
      'Step 1 — Identify every steering episode: a user turn AFTER the first whose purpose is to correct, redirect, veto, or re-scope what the agent is doing or just did. NOT steering: answering a question the agent asked, supplying requested information, plain approval ("looks good, continue"), or starting an unrelated new task.',
      'Step 2 — Classify each steer by its grounding:',
      '- "grounded": backed by domain knowledge or evidence — cites code, file paths, error messages, test/command output, docs, or concrete observed behavior, or gives a specific correct direction the agent can act on. A short steer can still be grounded.',
      '- "vague": redirection without substance — "that\'s not right", "try again", "still broken" — leaving the agent to rediscover what is wrong.',
      '- "misleading": confidently asserts something the transcript shows was wrong (wrong diagnosis, wrong file, false claim about behavior) and thereby sends the agent in a wrong direction that cost work.',
      "Step 3 — Classify the user's overall interaction mode across the session:",
      '- "augmentative": the user engages with the work — verifies claims, runs or tests things, reads the changes, asks probing questions, steers with evidence.',
      '- "delegative": the user passively accepts outputs without examination — approvals with no visible verification, no probing questions, no engagement with the substance.',
      'Judge only from what is visible in the transcript. The score is computed from your classifications in code (grounded steers and examined acceptance score high; chains of consecutive vague/misleading steers and pure unexamined acceptance are penalized); do not output a score.',
    ].join('\n'),
    jsonFormatSpec(
      `{
  "steers": [ { "turn": number, "subject": string, "grounding": "grounded" | "vague" | "misleading", "note": string } ],
  "mode": "augmentative" | "delegative",
  "modeTurn": number,
  "modeNote": string,
  "advice": [string]
}`,
      [
        '"turn" is the user turn where the steer happened. "subject" is a short headline (at most ~8 words) naming what the steer was about; "note" explains the evidence (or its absence) and the effect on the agent, without repeating the subject.',
        'If the user never steered, return an empty "steers" array — the mode classification still applies.',
        '"modeTurn" is the turn that best evidences the mode; "modeNote" justifies the classification in 1-2 sentences.',
        '"advice" targets the USER: how to steer and verify more effectively next time — e.g. paste the exact error, cite the file, state what was observed vs expected, or spot-check a claim before accepting it — grounded in what happened in THIS session.',
      ],
    ),
    buildSessionBlock(session),
  ].join('\n\n');
}

/** grounded -> pass, vague -> mixed, misleading -> fail (existing statuses only). */
const GROUNDING_STATUS: Record<Grounding, FindingStatus> = {
  grounded: 'satisfied',
  vague: 'unclear',
  misleading: 'violated',
};
const GROUNDING_POINTS: Record<Grounding, number> = { grounded: 1, vague: 0.4, misleading: 0 };
const GROUNDING_ORDER: Record<Grounding, number> = { misleading: 0, vague: 1, grounded: 2 };
const GROUNDING_LABEL: Record<Grounding, string> = {
  grounded: 'Grounded steer',
  vague: 'Vague steer',
  misleading: 'Misleading steer',
};

/** Extra penalty per consecutive ungrounded->ungrounded steer pair (a "chain link"). */
const CHAIN_PENALTY_PER_LINK = 0.1;
const CHAIN_PENALTY_CAP = 0.3;
/** Penalty when steering happened but the overall mode was still delegative. */
const DELEGATIVE_MODE_PENALTY = 0.15;
/** Score for a session with zero steers and pure unexamined acceptance. */
const DELEGATIVE_NO_STEERS_SCORE = 0.45;

/** Count adjacent (in turn order) pairs where both steers are vague or misleading. */
export function countUngroundedChainLinks(steers: readonly JudgedSteer[]): number {
  const ordered = [...steers].sort((a, b) => a.turn - b.turn);
  let links = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    if (prev.grounding !== 'grounded' && curr.grounding !== 'grounded') links += 1;
  }
  return links;
}

function computeScore(steers: readonly JudgedSteer[], mode: InteractionMode): number {
  if (steers.length === 0) {
    return mode === 'augmentative' ? 1 : DELEGATIVE_NO_STEERS_SCORE;
  }
  const base =
    steers.reduce((sum, steer) => sum + GROUNDING_POINTS[steer.grounding], 0) / steers.length;
  const chainPenalty = Math.min(
    countUngroundedChainLinks(steers) * CHAIN_PENALTY_PER_LINK,
    CHAIN_PENALTY_CAP,
  );
  const modePenalty = mode === 'delegative' ? DELEGATIVE_MODE_PENALTY : 0;
  return clampScore(base - chainPenalty - modePenalty);
}

export const steeringGroundingMetric: Metric = {
  id: 'steering-grounding',
  version: 1,
  name: 'Steering Grounding',
  description:
    'Classifies each user steering episode as grounded, vague, or misleading and the overall interaction mode as augmentative vs delegative; evidence-backed steering and examined acceptance score high.',
  target: 'user',
  async evaluate(session: Session, judge: Judge): Promise<MetricResult> {
    const stats = computeSessionStats(session);
    const response = await judge.evaluate({
      prompt: buildPrompt(session, stats),
      schema: responseSchema,
    });

    const findings: RawFinding[] = [];
    if (response.mode === 'delegative') {
      findings.push({
        turn: response.modeTurn,
        label: 'Delegative interaction mode',
        status: 'issue',
        note: response.modeNote,
      });
    }
    const orderedSteers = [...response.steers].sort(
      (a, b) => GROUNDING_ORDER[a.grounding] - GROUNDING_ORDER[b.grounding] || a.turn - b.turn,
    );
    for (const steer of orderedSteers) {
      findings.push({
        turn: steer.turn,
        label: `${GROUNDING_LABEL[steer.grounding]}: ${steer.subject}`,
        status: GROUNDING_STATUS[steer.grounding],
        note: steer.note,
      });
    }

    return makeResult(
      computeScore(response.steers, response.mode),
      findings,
      response.advice,
      session.turns.length,
    );
  },
};
