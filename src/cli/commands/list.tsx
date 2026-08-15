/**
 * `agent-evals list` — print recent sessions (id, agent, age, turns,
 * evaluated?, project, title) to stdout, merged across the active agent
 * sources by recency. The evaluated? column counts distinct metrics with
 * stored DB results for each session's current transcript state; the agent
 * column appears when more than one source is active.
 */

import { sourceById } from '../../adapters/index.js';
import { openDb } from '../../store/db.js';
import type { ListOptions } from '../args.js';
import { relativeAge } from '../format.js';
import { SessionTable, type SessionListRow } from '../ui/SessionTable.js';
import { printArtifact } from '../ui/artifact.js';
import {
  DEFAULT_SESSION_LIMIT,
  listSessionsAcrossSources,
  loadConfigWithNotice,
  resolveSources,
} from './shared.js';

export async function runListCommand(options: ListOptions): Promise<number> {
  const config = loadConfigWithNotice();
  const sources = resolveSources(options.agents, config);

  const metas = await listSessionsAcrossSources(sources, {
    limit: options.limit ?? DEFAULT_SESSION_LIMIT,
    ...(options.project !== undefined ? { project: options.project } : {}),
  });
  if (metas.length === 0) {
    console.error(
      `agent-evals: no sessions found for agents ${sources.map((s) => s.id).join(', ')}`,
    );
    return 1;
  }

  const db = openDb();
  let rows: SessionListRow[];
  try {
    rows = await Promise.all(
      metas.map(async (meta): Promise<SessionListRow> => {
        let turns = '?';
        let evaluatedMetrics = 0;
        try {
          const session = await sourceById(meta.agent)!.loadSession(meta);
          turns = String(session.turns.length);
          evaluatedMetrics = db.countEvaluatedMetrics(session.contentHash);
        } catch {
          // unreadable transcript; keep the row with unknown turn count
        }
        return {
          id: meta.id,
          agent: meta.agent,
          age: relativeAge(meta.updatedAt),
          turns,
          evaluatedMetrics,
          project: meta.project,
          title: meta.title,
        };
      }),
    );
  } finally {
    db.close();
  }

  await printArtifact(<SessionTable rows={rows} showAgent={sources.length > 1} />);
  return 0;
}
