/**
 * Ad-hoc verification of the Cursor adapter against real local data:
 *   pnpm exec tsx scripts/verify-cursor-adapter.ts
 *
 * Lists recent sessions (db titles + fallback behavior), loads sessions from
 * different projects, and prints turn counts, derived stats, and extracted
 * user queries.
 */

import { CursorSource, cursorSource } from '../src/adapters/cursor.js';
import { computeSessionStats } from '../src/model/session.js';

function age(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// 1. Recent sessions with titles from the search db.
const recent = await cursorSource.listSessions({ limit: 10 });
console.log(`=== ${recent.length} most recent sessions ===`);
for (const m of recent) {
  console.log(`- [${age(m.updatedAt).padStart(7)}] ${m.title}  (project: ${m.project}, id: ${m.id.slice(0, 8)})`);
}

// 2. Fallback path: point at a bogus db, titles must come from user-query snippets.
const noDb = new CursorSource({ searchDbPath: '/nonexistent/conversation-search.db' });
const fallback = await noDb.listSessions({ limit: 5 });
console.log('\n=== same listing with db unavailable (snippet titles, mtime recency) ===');
for (const m of fallback) {
  console.log(`- [${age(m.updatedAt).padStart(7)}] ${m.title}  (project: ${m.project})`);
}

// 3. Load sessions from different projects; print stats and extracted queries.
const byProject = new Map<string, (typeof recent)[number]>();
for (const m of await cursorSource.listSessions({ limit: 100 })) {
  if (!byProject.has(m.project)) byProject.set(m.project, m);
  if (byProject.size >= 3) break;
}
console.log('\n=== loaded sessions ===');
for (const meta of byProject.values()) {
  const session = await cursorSource.loadSession(meta);
  const stats = computeSessionStats(session);
  console.log(`\n"${session.title}" (${session.project})`);
  console.log(
    `  turns=${stats.turnCount} (user=${stats.userTurnCount}, assistant=${stats.assistantTurnCount})`,
    `toolCalls=${stats.toolCallCount} repeated=${stats.repeatedToolCalls.length} steering=${stats.userSteeringMessageCount}`,
  );
  const topTools = Object.entries(stats.toolCallDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, c]) => `${n}:${c}`)
    .join(' ');
  console.log(`  top tools: ${topTools}`);
  const firstUser = session.turns.find((t) => t.role === 'user');
  console.log(`  first user query: ${JSON.stringify(firstUser?.text.slice(0, 160))}`);
}

// 4. loadSession by uuid and by path resolve to the same session.
const target = recent[0];
if (target !== undefined) {
  const byId = await cursorSource.loadSession(target.id);
  const byPath = await cursorSource.loadSession(target.transcriptPath);
  console.log(
    `\n=== ref forms agree: byId turns=${byId.turns.length}, byPath turns=${byPath.turns.length},`,
    `title match=${byId.title === byPath.title} ===`,
  );
}
