/**
 * Registry of the v1 metric library. `allMetrics` is the canonical run order:
 * agent-targeted, user-targeted, then collaboration.
 */

import type { Metric } from './types.js';
import { conversationEfficiencyMetric } from './conversation-efficiency.js';
import { goalCompletionMetric } from './goal-completion.js';
import { instructionAdherenceMetric } from './instruction-adherence.js';
import { promptQualityMetric } from './prompt-quality.js';
import { toolEfficiencyMetric } from './tool-efficiency.js';

export const allMetrics: Metric[] = [
  goalCompletionMetric,
  instructionAdherenceMetric,
  toolEfficiencyMetric,
  promptQualityMetric,
  conversationEfficiencyMetric,
];

export {
  conversationEfficiencyMetric,
  goalCompletionMetric,
  instructionAdherenceMetric,
  promptQualityMetric,
  toolEfficiencyMetric,
};
export type { Finding, FindingStatus, Metric, MetricResult, MetricTarget } from './types.js';
