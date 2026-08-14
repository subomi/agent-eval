/**
 * Tool Efficiency (target: agent). Hybrid metric: deterministic signals from
 * `computeSessionStats()` (repeated identical calls, failure counts, tool
 * distribution) are fed into the judge prompt alongside the rendered session;
 * the judge scores thrash/redundancy and cites wasteful sequences.
 */

import { computeSessionStats, type Session } from '../model/session.js';
import type { Judge } from '../judge/types.js';
import type { Metric, MetricResult } from './types.js';
import {
  CODING_SESSION_PREAMBLE,
  asIssueFindings,
  buildSessionBlock,
  formatStatsBlock,
  jsonFormatSpec,
  makeResult,
  scoredResponseSchema,
} from './shared.js';
import type { SessionStats } from '../model/session.js';

function buildPrompt(session: Session, stats: SessionStats): string {
  return [
    CODING_SESSION_PREAMBLE,
    'Metric: TOOL EFFICIENCY — did the agent use its tools (file reads/edits, terminal commands, code searches) purposefully, or did it thrash?',
    `Deterministic signals computed from the transcript (trust these counts, but confirm the surrounding context in the transcript before penalizing):\n${formatStatsBlock(stats)}`,
    [
      'Assess:',
      '- Redundancy: identical or near-identical calls repeated with no new information in between (re-reading an unchanged file, re-running the same search or listing).',
      '- Failure loops: failed commands retried unchanged instead of diagnosing the error; error output ignored.',
      '- Wasted breadth: broad dumps or scans where a targeted read/search was clearly available.',
      '- Progress per call: did each call visibly advance the task?',
      'Some repetition is legitimate — re-reading a file AFTER editing it, or re-running tests after a fix, is good practice. Only penalize repetition that gained nothing.',
      'Scoring guidance: 1.0 = essentially every call purposeful; ~0.7 = mostly purposeful with limited redundancy; ~0.4 = noticeable thrash (failure loops or many redundant calls); below 0.2 = the majority of calls were waste.',
    ].join('\n'),
    jsonFormatSpec(
      `{
  "score": number,
  "findings": [ { "turn": number, "label": string, "note": string } ],
  "advice": [string]
}`,
      [
        '"score" must be between 0 and 1.',
        'Findings must cite the specific wasteful sequences. "label" is a short headline (at most ~8 words) naming the waste; "note" explains what happened at that turn and what a better call would have been, without repeating the label.',
        '"advice" targets the AGENT: how to use tools more efficiently on this kind of task.',
      ],
    ),
    buildSessionBlock(session),
  ].join('\n\n');
}

export const toolEfficiencyMetric: Metric = {
  id: 'tool-efficiency',
  version: 1,
  name: 'Tool Efficiency',
  description:
    'Scores how purposefully the agent used tools, combining deterministic repeat/failure signals with judge assessment of thrash.',
  target: 'agent',
  async evaluate(session: Session, judge: Judge): Promise<MetricResult> {
    const stats = computeSessionStats(session);
    if (stats.toolCallCount === 0) {
      // Nothing to judge: a session without tool calls cannot waste tool calls.
      return { score: 1, findings: [], advice: [] };
    }
    const response = await judge.evaluate({
      prompt: buildPrompt(session, stats),
      schema: scoredResponseSchema,
    });
    return makeResult(
      response.score,
      asIssueFindings(response.findings),
      response.advice,
      session.turns.length,
    );
  },
};
