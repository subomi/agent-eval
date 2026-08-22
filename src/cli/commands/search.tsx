/**
 * `agent-evals search <terms…>` — find sessions across the active agent
 * sources. Every term must match (case-insensitive) somewhere in the
 * session's title, project, id, or agent; matches print as the same table
 * `list` uses, newest first.
 */

import type { SearchOptions } from '../args.js';
import { SessionTable } from '../ui/SessionTable.js';
import { printArtifact } from '../ui/artifact.js';
import {
  buildSessionRows,
  listSessionsAcrossSources,
  loadConfigWithNotice,
  resolveSources,
} from './shared.js';

export async function runSearchCommand(options: SearchOptions): Promise<number> {
  const config = loadConfigWithNotice();
  const sources = resolveSources(options.agents, config);

  const metas = await listSessionsAcrossSources(sources, {
    ...(options.project !== undefined ? { project: options.project } : {}),
  });

  const terms = options.query.map((term) => term.toLowerCase());
  let matches = metas.filter((meta) => {
    const haystack = `${meta.id} ${meta.agent} ${meta.project} ${meta.title}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  if (matches.length === 0) {
    console.error(
      `agent-evals: no sessions matched "${options.query.join(' ')}" ` +
        `across ${metas.length} sessions (agents: ${sources.map((s) => s.id).join(', ')})`,
    );
    return 1;
  }
  const total = matches.length;
  if (options.limit !== undefined) matches = matches.slice(0, options.limit);

  const rows = await buildSessionRows(matches);
  await printArtifact(<SessionTable rows={rows} showAgent={sources.length > 1} />);
  console.error(
    (matches.length < total
      ? `${matches.length} of ${total} matches shown (--limit)`
      : `${total} ${total === 1 ? 'match' : 'matches'}`) +
      ' — evaluate one with: agent-evals eval --session <id>',
  );
  return 0;
}
