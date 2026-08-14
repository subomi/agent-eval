/**
 * Conversation Efficiency (target: collab). The judge assesses rework loops,
 * wasted turns, and whether turns-to-resolution was proportionate to the
 * task. Advice may target either party.
 */

import { computeSessionStats, type Session, type SessionStats } from '../model/session.js';
import type { Judge } from '../judge/types.js';
import type { Metric, MetricResult } from './types.js';
import {
  CODING_SESSION_PREAMBLE,
  asIssueFindings,
  buildSessionBlock,
  jsonFormatSpec,
  makeResult,
  scoredResponseSchema,
} from './shared.js';

function formatConversationStats(stats: SessionStats): string {
  return [
    `- Turns: ${stats.turnCount} total (${stats.userTurnCount} user, ${stats.assistantTurnCount} assistant)`,
    `- Tool calls: ${stats.toolCallCount} (${stats.failedToolCallCount} failed)`,
    `- User turns that look like corrections/steering (conservative keyword heuristic, lower bound): ${stats.userSteeringMessageCount}`,
  ].join('\n');
}

function buildPrompt(session: Session, stats: SessionStats): string {
  return [
    CODING_SESSION_PREAMBLE,
    'Metric: CONVERSATION EFFICIENCY — was the number of turns proportionate to the task, or was effort wasted in rework loops? This scores the user-agent COLLABORATION as a whole.',
    `Conversation-level statistics:\n${formatConversationStats(stats)}`,
    [
      'Assess:',
      '- Rework loops: the user corrects, the agent redoes work that could have been right the first time. Attribute each loop\'s cause: an ambiguous or incomplete request (user side), ignored instructions or wrong assumptions (agent side), or reasonable iteration on genuinely uncertain work (nobody\'s fault).',
      '- Wasted turns: turns that added no progress — repeated explanations, unnecessary confirmations or permission-asking, going in circles.',
      "- Proportionality: given the task's actual size and difficulty, was the turns-to-resolution reasonable? A one-line fix should not take a long back-and-forth; a large refactor legitimately takes many turns.",
      'Honest iteration on exploratory work is not waste. Penalize avoidable loops, not inherent difficulty.',
      'Scoring guidance: 1.0 = tight session, essentially no avoidable turns; ~0.7 = minor avoidable back-and-forth; ~0.4 = at least one full rework loop or sustained circling; below 0.2 = most of the session was avoidable rework.',
    ].join('\n'),
    jsonFormatSpec(
      `{
  "score": number,
  "findings": [ { "turn": number, "label": string, "note": string } ],
  "advice": [string]
}`,
      [
        '"score" must be between 0 and 1.',
        'Findings cite where each rework loop or run of wasted turns began. "label" is a short headline (at most ~8 words) naming the loop or waste; "note" explains what happened and what caused it, without repeating the label.',
        '"advice" may target either party; prefix each string with "User:" or "Agent:" to say who should change what.',
      ],
    ),
    buildSessionBlock(session),
  ].join('\n\n');
}

export const conversationEfficiencyMetric: Metric = {
  id: 'conversation-efficiency',
  version: 1,
  name: 'Conversation Efficiency',
  description:
    'Scores the collaboration: rework loops, wasted turns, and whether turns-to-resolution matched the size of the task.',
  target: 'collab',
  async evaluate(session: Session, judge: Judge): Promise<MetricResult> {
    const stats = computeSessionStats(session);
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
