/**
 * Goal Completion (target: agent). The judge extracts the user's intents from
 * the session and judges each satisfied/partial/unsatisfied as of session
 * end. Score = satisfied ratio with partial counting 0.5.
 */

import type { Session } from '../model/session.js';
import type { Judge, SchemaLike } from '../judge/types.js';
import type { Metric, MetricResult } from './types.js';
import {
  CODING_SESSION_PREAMBLE,
  buildSessionBlock,
  expectArray,
  expectEnum,
  expectRecord,
  expectString,
  expectTurnNumber,
  jsonFormatSpec,
  makeResult,
  optionalTurnNumber,
  parseAdvice,
  type RawFinding,
} from './shared.js';

const INTENT_STATUSES = ['satisfied', 'partial', 'unsatisfied'] as const;
type IntentStatus = (typeof INTENT_STATUSES)[number];

interface JudgedIntent {
  intent: string;
  statedTurn: number;
  status: IntentStatus;
  evidenceTurn: number | undefined;
  note: string;
}

interface GoalCompletionResponse {
  intents: JudgedIntent[];
  advice: string[];
}

const responseSchema: SchemaLike<GoalCompletionResponse> = {
  parse(input: unknown): GoalCompletionResponse {
    const root = expectRecord(input, 'response');
    const intents = expectArray(root['intents'], 'intents').map((item, i): JudgedIntent => {
      const record = expectRecord(item, `intents[${i}]`);
      return {
        intent: expectString(record['intent'], `intents[${i}].intent`),
        statedTurn: expectTurnNumber(record['statedTurn'], `intents[${i}].statedTurn`),
        status: expectEnum(record['status'], `intents[${i}].status`, INTENT_STATUSES),
        evidenceTurn: optionalTurnNumber(record['evidenceTurn'], `intents[${i}].evidenceTurn`),
        note: expectString(record['note'], `intents[${i}].note`),
      };
    });
    return { intents, advice: parseAdvice(root['advice'], 'advice') };
  },
};

function buildPrompt(session: Session): string {
  return [
    CODING_SESSION_PREAMBLE,
    'Metric: GOAL COMPLETION — did the agent actually accomplish what the user asked for by the end of the session?',
    [
      'Step 1 — Extract every distinct user intent: each concrete outcome the user asked for (a feature built, a bug fixed, a question answered, a refactor done, an investigation completed). Include intents added or revised mid-session, using the final version of a revised intent. Ignore greetings and process chatter, and do not invent intents the user never expressed.',
      'Step 2 — Judge each intent as of the LAST turn of the session:',
      '- "satisfied": clearly achieved, and nothing later contradicts it.',
      '- "partial": real progress, but incomplete, unverified, or delivered with unresolved caveats.',
      '- "unsatisfied": not achieved, abandoned, or the agent claimed success while the evidence contradicts it.',
      "The agent CLAIMING success is not evidence. Prefer tool results, test/terminal output, file edits, and the user's own follow-up reactions.",
    ].join('\n'),
    jsonFormatSpec(
      `{
  "intents": [
    { "intent": string, "statedTurn": number, "status": "satisfied" | "partial" | "unsatisfied", "evidenceTurn": number, "note": string }
  ],
  "advice": [string]
}`,
      [
        '"statedTurn" is the turn where the user expressed the intent; "evidenceTurn" is the turn with the strongest evidence for the status.',
        '"intent" is a short subject line (the outcome the user asked for). "note" explains the evidence at evidenceTurn in 1-2 sentences; it is displayed underneath the intent, so do NOT restate the intent text inside it.',
        '"advice" targets the AGENT: what it should have done differently in this session to satisfy more intents (e.g. verify before claiming done, finish an abandoned sub-task).',
      ],
    ),
    buildSessionBlock(session),
  ].join('\n\n');
}

export const goalCompletionMetric: Metric = {
  id: 'goal-completion',
  version: 1,
  name: 'Goal Completion',
  description:
    "Extracts the user's intents and judges how many were satisfied by session end (partial credit = 0.5).",
  target: 'agent',
  async evaluate(session: Session, judge: Judge): Promise<MetricResult> {
    const response = await judge.evaluate({ prompt: buildPrompt(session), schema: responseSchema });
    const turnCount = session.turns.length;

    if (response.intents.length === 0) {
      return makeResult(
        0.5,
        [{ turn: 1, note: 'Judge could not extract any concrete user intents from this session.' }],
        response.advice,
        turnCount,
      );
    }

    let points = 0;
    const findings: RawFinding[] = [];
    for (const intent of response.intents) {
      if (intent.status === 'satisfied') points += 1;
      else if (intent.status === 'partial') points += 0.5;
      findings.push({
        turn: intent.evidenceTurn ?? intent.statedTurn,
        label: intent.intent,
        status: intent.status,
        note: intent.note,
      });
    }
    return makeResult(points / response.intents.length, findings, response.advice, turnCount);
  },
};
