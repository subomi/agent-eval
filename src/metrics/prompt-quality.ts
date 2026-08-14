/**
 * Prompt Quality (target: user). The judge scores the user's initial prompt —
 * goal clarity, context/constraint completeness, definition of done — using
 * the rest of the session as evidence of what the agent was left to guess.
 * Score = mean of the three sub-scores.
 */

import type { Session } from '../model/session.js';
import type { Judge, SchemaLike } from '../judge/types.js';
import type { Metric, MetricResult } from './types.js';
import {
  CODING_SESSION_PREAMBLE,
  asIssueFindings,
  buildSessionBlock,
  clampScore,
  expectNumber,
  expectRecord,
  jsonFormatSpec,
  makeResult,
  parseAdvice,
  parseRawFindings,
  type RawFinding,
} from './shared.js';

interface PromptQualityResponse {
  goalClarity: number;
  contextCompleteness: number;
  definitionOfDone: number;
  findings: RawFinding[];
  advice: string[];
}

const responseSchema: SchemaLike<PromptQualityResponse> = {
  parse(input: unknown): PromptQualityResponse {
    const root = expectRecord(input, 'response');
    return {
      goalClarity: expectNumber(root['goalClarity'], 'goalClarity'),
      contextCompleteness: expectNumber(root['contextCompleteness'], 'contextCompleteness'),
      definitionOfDone: expectNumber(root['definitionOfDone'], 'definitionOfDone'),
      findings: parseRawFindings(root['findings'], 'findings'),
      advice: parseAdvice(root['advice'], 'advice'),
    };
  },
};

function buildPrompt(session: Session): string {
  return [
    CODING_SESSION_PREAMBLE,
    "Metric: PROMPT QUALITY — how well did the USER's prompting (especially the first message) set the agent up to succeed?",
    [
      "Evaluate the user's initial prompt, using the rest of the session as evidence of how much the agent was left to guess: clarifying questions the agent had to ask, wrong guesses it made because information was missing, and context or constraints the user only supplied after something went wrong (drip-feeding) all point to gaps in the initial prompt.",
      'Score three dimensions independently, each 0 to 1:',
      '- "goalClarity": is the desired outcome specific and unambiguous? (1.0 = a stranger could restate exactly what is wanted and for which part of the codebase; 0 = a vague wish.)',
      '- "contextCompleteness": did the user provide the context and constraints this task actually needed (relevant files/paths, environment and tooling, scope boundaries, things NOT to touch), or did the agent have to discover or guess them?',
      '- "definitionOfDone": would the user and the agent agree on when the task is finished (acceptance criteria, tests passing, expected behavior)?',
      'Only penalize missing information the task actually needed — a short prompt for a genuinely simple, self-contained task can score high on all three.',
    ].join('\n'),
    jsonFormatSpec(
      `{
  "goalClarity": number,
  "contextCompleteness": number,
  "definitionOfDone": number,
  "findings": [ { "turn": number, "label": string, "note": string } ],
  "advice": [string]
}`,
      [
        'All three dimension scores must be between 0 and 1.',
        "Findings cite the initial prompt's specific gaps (turn of the first user message) and the later turns where the agent had to guess, ask, or be corrected because of them. \"label\" is a short headline (at most ~8 words) naming the gap; \"note\" explains the consequence, without repeating the label.",
        '"advice" targets the USER: exactly what to add or phrase differently in the initial prompt next time, grounded in what went wrong or was missing in THIS session.',
      ],
    ),
    buildSessionBlock(session),
  ].join('\n\n');
}

export const promptQualityMetric: Metric = {
  id: 'prompt-quality',
  version: 1,
  name: 'Prompt Quality',
  description:
    "Scores the user's initial prompt on goal clarity, context/constraint completeness, and definition of done, using how much the agent had to guess as evidence.",
  target: 'user',
  async evaluate(session: Session, judge: Judge): Promise<MetricResult> {
    const response = await judge.evaluate({ prompt: buildPrompt(session), schema: responseSchema });
    const score =
      (clampScore(response.goalClarity) +
        clampScore(response.contextCompleteness) +
        clampScore(response.definitionOfDone)) /
      3;
    return makeResult(score, asIssueFindings(response.findings), response.advice, session.turns.length);
  },
};
