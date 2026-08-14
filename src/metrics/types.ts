/**
 * Contract for eval metrics. Phase 2 implements the v1 metric library
 * (Goal Completion, Prompt Quality, Tool Efficiency, Instruction Adherence,
 * Conversation Efficiency) against this interface.
 */

import type { Session } from '../model/session.js';
import type { Judge } from '../judge/types.js';

/** Who the metric's feedback is aimed at. */
export type MetricTarget = 'user' | 'agent' | 'collab';

/**
 * Verdict attached to a finding. The renderer groups these into three
 * severities: pass (`satisfied`/`respected`), mixed (`partial`/`unclear`),
 * and fail (`unsatisfied`/`violated`), plus `issue` for generic cited
 * problems from metrics that don't judge per-item verdicts.
 */
export type FindingStatus =
  | 'satisfied'
  | 'partial'
  | 'unsatisfied'
  | 'respected'
  | 'unclear'
  | 'violated'
  | 'issue';

/** A piece of evidence cited by turn number. */
export interface Finding {
  /** 1-based turn index the evidence refers to (`Turn.index`). */
  turnRef: number;
  /** Short subject being judged: an extracted intent, instruction, or issue headline. */
  label?: string;
  /** Verdict on the subject; absent for plain evidence notes. */
  status?: FindingStatus;
  /** Explanation: what happened at the referenced turn and why it supports the verdict. */
  note: string;
}

export interface MetricResult {
  /** 0 (worst) to 1 (best). */
  score: number;
  /** Evidence backing the score, cited by turn. */
  findings: Finding[];
  /** Concrete "do this differently" suggestions, most important first. */
  advice: string[];
}

export interface Metric {
  /** Stable machine id, e.g. "goal-completion". Persisted with runs. */
  id: string;
  /** Bumped whenever the scoring methodology changes. Persisted with runs. */
  version: number;
  /** Human-readable name, e.g. "Goal Completion". */
  name: string;
  description: string;
  target: MetricTarget;
  /**
   * Evaluate the session. Implementations may combine a deterministic
   * pre-pass (see `computeSessionStats`) with judge calls, and should use
   * the session rendering utilities to stay within prompt budgets.
   */
  evaluate(session: Session, judge: Judge): Promise<MetricResult>;
}
