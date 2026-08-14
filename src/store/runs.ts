/**
 * Versioned run persistence: one JSON file per eval run under
 * `~/.agent-evals/runs/<session-id>-<epoch-ms>.json`. This is the substrate
 * for the future batch-eval / trends / graphs phase, so the schema carries
 * everything needed to re-aggregate without the original transcript.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Finding, Metric, MetricResult, MetricTarget } from '../metrics/index.js';
import { computeSessionStats, type Session, type SessionStats } from '../model/session.js';

/**
 * v2: findings are structured — optional `label` (judged subject) and
 * `status` (verdict) fields alongside `note`, replacing the v1
 * "[status] subject — note" concatenated strings.
 */
export const RUN_SCHEMA_VERSION = 2;

export interface RunMetricRecord {
  id: string;
  version: number;
  name: string;
  target: MetricTarget;
  /** 0 (worst) to 1 (best). */
  score: number;
  findings: Finding[];
  advice: string[];
}

export interface RunRecord {
  schemaVersion: number;
  sessionId: string;
  agent: string;
  project: string;
  title: string;
  /** ISO-8601 timestamp of when the eval ran. */
  evaluatedAt: string;
  /** Judge model as "provider/model-id". */
  model: string;
  sessionStats: SessionStats;
  metrics: RunMetricRecord[];
  /** Unweighted average of the metric scores. */
  overallScore: number;
}

export function defaultRunsDir(): string {
  return join(homedir(), '.agent-evals', 'runs');
}

export function buildRunRecord(input: {
  session: Session;
  model: string;
  results: readonly { metric: Metric; result: MetricResult }[];
  evaluatedAt?: Date;
}): RunRecord {
  const metrics: RunMetricRecord[] = input.results.map(({ metric, result }) => ({
    id: metric.id,
    version: metric.version,
    name: metric.name,
    target: metric.target,
    score: result.score,
    findings: result.findings,
    advice: result.advice,
  }));

  const overallScore =
    metrics.length === 0 ? 0 : metrics.reduce((sum, m) => sum + m.score, 0) / metrics.length;

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    sessionId: input.session.id,
    agent: input.session.agent,
    project: input.session.project,
    title: input.session.title,
    evaluatedAt: (input.evaluatedAt ?? new Date()).toISOString(),
    model: input.model,
    sessionStats: computeSessionStats(input.session),
    metrics,
    overallScore,
  };
}

/** Write the run to disk and return the file path. */
export async function saveRun(run: RunRecord, dir: string = defaultRunsDir()): Promise<string> {
  const epochMs = Date.parse(run.evaluatedAt);
  const filePath = join(dir, `${run.sessionId}-${epochMs}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return filePath;
}
