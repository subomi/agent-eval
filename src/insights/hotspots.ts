/**
 * Repetition hotspots: cluster every stored directive into themes with ONE
 * judge call, then compute counts deterministically from the returned
 * membership. The judge only groups and drafts; session counts, repetition
 * rate, and example quotes come from the rows themselves.
 *
 * The clustering response is disk-cached like any judge call, so re-running
 * `insights` over an unchanged directive set costs no API calls.
 */

import type { Judge, SchemaLike } from '../judge/types.js';
import {
  expectArray,
  expectEnum,
  expectNumber,
  expectRecord,
  expectString,
} from '../metrics/shared.js';
import type { DirectiveRow } from '../store/db.js';
import type { ArtifactKind, HotspotCluster, HotspotsReport } from './types.js';

const ARTIFACT_KINDS = ['cursor-rule', 'agents-md', 'skill', 'prompt-template'] as const;
const MAX_DIRECTIVES = 400;
const MAX_CLUSTERS = 8;
const MAX_EXAMPLES = 2;

interface RawCluster {
  theme: string;
  members: number[];
  artifact: ArtifactKind;
  draft: string;
}

const responseSchema: SchemaLike<RawCluster[]> = {
  parse(input: unknown): RawCluster[] {
    const root = expectRecord(input, 'response');
    const raw = root['clusters'];
    if (raw === undefined || raw === null) return [];
    return expectArray(raw, 'clusters').map((item, i) => {
      const record = expectRecord(item, `clusters[${i}]`);
      return {
        theme: expectString(record['theme'], `clusters[${i}].theme`),
        members: expectArray(record['directives'], `clusters[${i}].directives`).map((n, j) =>
          expectNumber(n, `clusters[${i}].directives[${j}]`),
        ),
        artifact: expectEnum(record['artifact'], `clusters[${i}].artifact`, ARTIFACT_KINDS),
        draft: expectString(record['draft'], `clusters[${i}].draft`),
      };
    });
  },
};

function buildPrompt(directives: readonly DirectiveRow[]): string {
  const lines = directives.map((d, i) => `${i + 1}. [${d.kind}] ${d.text}`);
  return [
    'You are analyzing "directives": durable rules a user gave their coding agent, extracted from many recorded sessions. The user keeps re-typing some of these; your job is to cluster them into themes so repeated guidance can be turned into standing configuration once.',
    `Directives (one per line, "N. [kind] text"):\n${lines.join('\n')}`,
    [
      'Task: group directives that express the same underlying rule — or closely related guidance that one artifact could cover — into clusters. Merge restatements aggressively: the same rule in different words is one cluster. Only emit clusters with at least 2 member directives; leave truly one-off directives out. For each cluster provide:',
      '- "theme": a short name for the rule (at most 8 words).',
      '- "directives": the member directive numbers.',
      '- "artifact": where this guidance should live so it never needs repeating — "cursor-rule" (a Cursor rule file, best for coding standards and project conventions), "agents-md" (a line in AGENTS.md, best for short always-on operational rules), "skill" (a reusable SKILL.md, best for multi-step workflows worth packaging), or "prompt-template" (boilerplate to paste into prompts, best for per-task context the user re-explains).',
      '- "draft": ready-to-paste draft text for that artifact, at most 3 short lines, written in the imperative.',
    ].join('\n'),
    `Required response format:
{
  "clusters": [ { "theme": string, "directives": number[], "artifact": "cursor-rule" | "agents-md" | "skill" | "prompt-template", "draft": string } ]
}

Rules:
- Output ONLY one JSON object in exactly this shape. No prose, no markdown, no code fences.
- Every member number must match a directive number from the list; each directive belongs to at most one cluster.
- Clusters need at least 2 members. If no directives repeat, return an empty "clusters" array.`,
  ].join('\n\n');
}

export async function computeHotspots(
  directives: readonly DirectiveRow[],
  totalSessions: number,
  judge: Judge,
): Promise<HotspotsReport> {
  const sessionsWithDirectives = new Set(directives.map((d) => d.sessionId)).size;
  const base = {
    directiveCount: directives.length,
    sessionsWithDirectives,
  };

  if (directives.length === 0) {
    return {
      ...base,
      status: 'no-directives',
      note: 'no directives extracted yet — hotspots appear after `agent-evals batch` runs the directive extractor',
      repetitionRate: null,
      clusters: [],
    };
  }

  // Bound the single-prompt clustering input; newest rows win.
  const truncated = directives.length > MAX_DIRECTIVES;
  const scoped = truncated ? directives.slice(-MAX_DIRECTIVES) : [...directives];

  let raw: RawCluster[];
  try {
    raw = await judge.evaluate({ prompt: buildPrompt(scoped), schema: responseSchema });
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      note: `directive clustering failed: ${error instanceof Error ? error.message : String(error)}`,
      repetitionRate: null,
      clusters: [],
    };
  }

  const clusters: HotspotCluster[] = [];
  const claimed = new Set<number>();
  // Sessions containing a repeated theme (one seen in >= 2 sessions), for
  // the repetition rate.
  const sessionsWithRepeats = new Set<string>();
  for (const cluster of raw) {
    const members: DirectiveRow[] = [];
    for (const number of cluster.members) {
      const index = Math.round(number) - 1;
      if (index < 0 || index >= scoped.length || claimed.has(index)) continue;
      claimed.add(index);
      members.push(scoped[index]!);
    }
    if (members.length < 2) continue;

    const sessions = new Set(members.map((m) => m.sessionId));
    if (sessions.size >= 2) {
      for (const id of sessions) sessionsWithRepeats.add(id);
    }
    const examples: string[] = [];
    for (const member of members) {
      if (!examples.includes(member.text)) examples.push(member.text);
      if (examples.length === MAX_EXAMPLES) break;
    }
    clusters.push({
      theme: cluster.theme,
      sessionCount: sessions.size,
      directiveCount: members.length,
      repeated: sessions.size >= 2,
      kinds: [...new Set(members.map((m) => m.kind))],
      examples,
      artifact: cluster.artifact,
      draft: cluster.draft,
    });
  }
  clusters.sort(
    (a, b) =>
      Number(b.repeated) - Number(a.repeated) ||
      b.sessionCount - a.sessionCount ||
      b.directiveCount - a.directiveCount,
  );

  const notes: string[] = [];
  if (truncated) {
    notes.push(`clustered the newest ${MAX_DIRECTIVES} of ${directives.length} directives`);
  }
  if (clusters.length === 0) {
    notes.push('no repeated themes found across sessions');
  }

  return {
    ...base,
    status: 'ok',
    note: notes.length > 0 ? notes.join('; ') : null,
    repetitionRate: totalSessions > 0 ? sessionsWithRepeats.size / totalSessions : null,
    clusters: clusters.slice(0, MAX_CLUSTERS),
  };
}
