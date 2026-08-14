/**
 * Instruction Adherence (target: agent). The judge extracts the user's
 * explicit instructions/constraints and checks whether the agent respected
 * each across the whole session. Score = respected ratio (unclear = 0.5);
 * violations are cited first.
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

const INSTRUCTION_STATUSES = ['respected', 'violated', 'unclear'] as const;
type InstructionStatus = (typeof INSTRUCTION_STATUSES)[number];

interface JudgedInstruction {
  instruction: string;
  sourceTurn: number;
  status: InstructionStatus;
  evidenceTurn: number | undefined;
  note: string;
}

interface InstructionAdherenceResponse {
  instructions: JudgedInstruction[];
  advice: string[];
}

const responseSchema: SchemaLike<InstructionAdherenceResponse> = {
  parse(input: unknown): InstructionAdherenceResponse {
    const root = expectRecord(input, 'response');
    const instructions = expectArray(root['instructions'], 'instructions').map(
      (item, i): JudgedInstruction => {
        const record = expectRecord(item, `instructions[${i}]`);
        return {
          instruction: expectString(record['instruction'], `instructions[${i}].instruction`),
          sourceTurn: expectTurnNumber(record['sourceTurn'], `instructions[${i}].sourceTurn`),
          status: expectEnum(record['status'], `instructions[${i}].status`, INSTRUCTION_STATUSES),
          evidenceTurn: optionalTurnNumber(record['evidenceTurn'], `instructions[${i}].evidenceTurn`),
          note: expectString(record['note'], `instructions[${i}].note`),
        };
      },
    );
    return { instructions, advice: parseAdvice(root['advice'], 'advice') };
  },
};

function buildPrompt(session: Session): string {
  return [
    CODING_SESSION_PREAMBLE,
    "Metric: INSTRUCTION ADHERENCE — did the agent respect the user's explicit instructions and constraints?",
    [
      'Step 1 — Extract every explicit instruction or constraint the user gave. Examples: "don\'t touch X", "only plan, don\'t implement yet", "use pnpm, not npm", "keep the diff minimal", "no new dependencies", "write tests first", output/format/style requirements, scope boundaries. The overall task goal itself is NOT an instruction (goal completion is measured separately). If the user later revoked or changed an instruction, use the final version.',
      "Step 2 — For each instruction, check the agent's behavior across the WHOLE session:",
      '- "respected": followed consistently everywhere it applied.',
      '- "violated": clearly broken at least once — cite where (e.g. an edit to a forbidden file, a command the user prohibited).',
      '- "unclear": the transcript does not show enough evidence either way.',
    ].join('\n'),
    jsonFormatSpec(
      `{
  "instructions": [
    { "instruction": string, "sourceTurn": number, "status": "respected" | "violated" | "unclear", "evidenceTurn": number, "note": string }
  ],
  "advice": [string]
}`,
      [
        '"sourceTurn" is the turn where the user stated the instruction; "evidenceTurn" is the turn with the strongest evidence for the status (for violations: where the violation happened).',
        '"instruction" is a short subject line quoting or paraphrasing the constraint. "note" explains the evidence in 1-2 sentences; it is displayed underneath the instruction, so do NOT restate the instruction text inside it.',
        'If the user gave no explicit instructions, return an empty "instructions" array.',
        '"advice" targets the AGENT: how to track and respect constraints better (or, if no explicit constraints were given, how it could still have confirmed scope before acting).',
      ],
    ),
    buildSessionBlock(session),
  ].join('\n\n');
}

const STATUS_ORDER: Record<InstructionStatus, number> = { violated: 0, unclear: 1, respected: 2 };

export const instructionAdherenceMetric: Metric = {
  id: 'instruction-adherence',
  version: 1,
  name: 'Instruction Adherence',
  description:
    "Extracts the user's explicit constraints and scores the ratio the agent respected, citing violations.",
  target: 'agent',
  async evaluate(session: Session, judge: Judge): Promise<MetricResult> {
    const response = await judge.evaluate({ prompt: buildPrompt(session), schema: responseSchema });
    const turnCount = session.turns.length;

    if (response.instructions.length === 0) {
      // Nothing to violate: perfect adherence by definition.
      return makeResult(1, [], response.advice, turnCount);
    }

    let points = 0;
    for (const item of response.instructions) {
      if (item.status === 'respected') points += 1;
      else if (item.status === 'unclear') points += 0.5;
    }

    const ordered = [...response.instructions].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
    );
    const findings: RawFinding[] = ordered.map((item) => ({
      turn: item.evidenceTurn ?? item.sourceTurn,
      label: item.instruction,
      status: item.status,
      note: item.note,
    }));

    return makeResult(points / response.instructions.length, findings, response.advice, turnCount);
  },
};
