/**
 * `agent-evals list` — print sessions (id, agent, age, turns, evaluated?,
 * project, title) to stdout, merged across the active agent sources by
 * recency. All sessions are listed unless `--limit` caps the output. The
 * evaluated? column counts distinct metrics with stored DB results for each
 * session's current transcript state; the agent column appears when more
 * than one source is active.
 */

import type { ListOptions } from '../args.js';
import { SessionTable } from '../ui/SessionTable.js';
import { printArtifact } from '../ui/artifact.js';
import {
  buildSessionRows,
  listSessionsAcrossSources,
  loadConfigWithNotice,
  resolveSources,
} from './shared.js';

export async function runListCommand(options: ListOptions): Promise<number> {
  const config = loadConfigWithNotice();
  const sources = resolveSources(options.agents, config);

  const metas = await listSessionsAcrossSources(sources, {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.project !== undefined ? { project: options.project } : {}),
  });
  if (metas.length === 0) {
    console.error(
      `agent-evals: no sessions found for agents ${sources.map((s) => s.id).join(', ')}`,
    );
    return 1;
  }

  const rows = await buildSessionRows(metas);
  await printArtifact(<SessionTable rows={rows} showAgent={sources.length > 1} />);
  return 0;
}
