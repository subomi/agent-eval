/**
 * Skill Utilization (target: agent). Hybrid metric: a deterministic pre-pass
 * scans this machine for installed agent skills (SKILL.md files) and detects
 * which of them the agent read during the session; the judge then decides
 * which installed skills plausibly SHOULD have triggered for the session's
 * tasks and, for each, whether it was used and whether its guidance was
 * actually followed. Score = followed ÷ should-have-triggered, with
 * used-but-not-followed counting 0.5.
 *
 * CAVEAT: transcripts do not contain the agent's system prompt, so the skill
 * inventory reflects what is installed on this machine NOW — which may differ
 * from what was available when the session ran. A "missed" verdict can
 * therefore be a false positive for skills installed after the session, and
 * skills since uninstalled are invisible to this metric.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { Session } from '../model/session.js';
import type { Judge, SchemaLike } from '../judge/types.js';
import type { Metric, MetricResult } from './types.js';
import {
  CODING_SESSION_PREAMBLE,
  buildSessionBlock,
  expectArray,
  expectEnum,
  expectRecord,
  expectString,
  expectTurnNumber,
  jsonFormatSpec,
  makeResult,
  parseAdvice,
  type RawFinding,
} from './shared.js';

// ---------------------------------------------------------------------------
// Deterministic pre-pass 1: installed-skill inventory
// ---------------------------------------------------------------------------

/** Max skills included in the judge prompt (shorter descriptions preferred). */
const MAX_INVENTORY_SKILLS = 60;
/** Per-skill description budget inside the judge prompt. */
const DESCRIPTION_MAX_CHARS = 240;
/** Recursion guard for the plugin-cache walks (deepest known layout is ~6). */
const MAX_SCAN_DEPTH = 8;

export interface InstalledSkill {
  /** Directory name containing the SKILL.md, e.g. "create-rule". */
  name: string;
  /** One-line description (frontmatter or first paragraph); may be empty. */
  description: string;
  /** Which root the skill came from, e.g. "cursor", "claude-plugin". */
  source: string;
}

interface SkillRoot {
  dir: string;
  source: string;
}

function defaultSkillRoots(home: string): SkillRoot[] {
  return [
    { dir: path.join(home, '.cursor', 'skills-cursor'), source: 'cursor' },
    { dir: path.join(home, '.codex', 'skills'), source: 'codex' },
    { dir: path.join(home, '.agents', 'skills'), source: 'agents' },
    { dir: path.join(home, '.cursor', 'plugins', 'cache'), source: 'cursor-plugin' },
    { dir: path.join(home, '.claude', 'plugins', 'cache'), source: 'claude-plugin' },
  ];
}

/** Recursively collect SKILL.md paths under `dir` (symlinked dirs not followed). */
async function findSkillFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // root absent on this machine, or unreadable — skip quietly
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await findSkillFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      out.push(full);
    }
  }
}

/**
 * Extract a one-line description from SKILL.md content: the YAML frontmatter
 * `description:` value when present (single-line, quoted, or block scalar),
 * otherwise the first non-heading paragraph of the body.
 */
export function extractSkillDescription(markdown: string): string {
  const lines = markdown.split('\n');
  let bodyStart = 0;

  if (lines[0]?.trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === '---') {
        end = i;
        break;
      }
    }
    if (end > 0) {
      bodyStart = end + 1;
      const fromFrontmatter = frontmatterDescription(lines.slice(1, end));
      if (fromFrontmatter !== undefined) return clip(fromFrontmatter);
    }
  }

  return clip(firstParagraph(lines.slice(bodyStart)) ?? '');
}

function frontmatterDescription(fmLines: readonly string[]): string | undefined {
  for (let i = 0; i < fmLines.length; i += 1) {
    const match = /^description:\s*(.*)$/.exec(fmLines[i] ?? '');
    if (match === null) continue;
    let value = (match[1] ?? '').trim();
    const isBlockScalar = value === '' || value === '>' || value === '|' || value === '>-' || value === '|-';
    if (isBlockScalar) value = '';
    // Fold any following indented continuation lines (block scalars and
    // wrapped plain values) into a single line.
    const parts: string[] = value.length > 0 ? [value] : [];
    for (let j = i + 1; j < fmLines.length; j += 1) {
      const line = fmLines[j] ?? '';
      if (!/^\s+\S/.test(line)) break;
      parts.push(line.trim());
    }
    const joined = parts.join(' ').trim();
    if (joined.length === 0) return undefined;
    return stripQuotes(joined);
  }
  return undefined;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function firstParagraph(bodyLines: readonly string[]): string | undefined {
  const paragraph: string[] = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line.length === 0) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue; // heading before the paragraph — skip it
    }
    paragraph.push(line);
  }
  return paragraph.length > 0 ? paragraph.join(' ') : undefined;
}

/** Collapse whitespace and cap at the per-skill description budget. */
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= DESCRIPTION_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, DESCRIPTION_MAX_CHARS - 1)}…`;
}

/**
 * Scan the machine for installed skills. Duplicate names (e.g. multiple
 * cached plugin versions) collapse to one entry, preferring the copy that
 * yielded a non-empty description.
 */
export async function scanInstalledSkills(
  roots: SkillRoot[] = defaultSkillRoots(homedir()),
): Promise<InstalledSkill[]> {
  const byName = new Map<string, InstalledSkill>();
  for (const root of roots) {
    const files: string[] = [];
    await findSkillFiles(root.dir, 0, files);
    for (const file of files) {
      const name = path.basename(path.dirname(file));
      let description = '';
      try {
        description = extractSkillDescription(await readFile(file, 'utf8'));
      } catch {
        // unreadable SKILL.md — keep the skill with an empty description
      }
      const existing = byName.get(name);
      if (existing === undefined || (existing.description === '' && description !== '')) {
        byName.set(name, { name, description, source: root.source });
      }
    }
  }
  return [...byName.values()];
}

/** Cap the inventory fed to the judge, preferring shorter descriptions. */
export function capInventory(skills: readonly InstalledSkill[]): InstalledSkill[] {
  if (skills.length <= MAX_INVENTORY_SKILLS) return [...skills];
  return [...skills]
    .sort((a, b) => a.description.length - b.description.length)
    .slice(0, MAX_INVENTORY_SKILLS);
}

// ---------------------------------------------------------------------------
// Deterministic pre-pass 2: skill reads detected in the session
// ---------------------------------------------------------------------------

/** Skill name -> turn indexes where its SKILL.md was read. */
export function detectSkillReads(session: Session): Map<string, number[]> {
  const reads = new Map<string, number[]>();
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if (call.name !== 'Read') continue;
      if (call.input === null || typeof call.input !== 'object') continue;
      const filePath = (call.input as { path?: unknown }).path;
      if (typeof filePath !== 'string' || !filePath.endsWith('SKILL.md')) continue;
      const skillName = path.basename(path.dirname(filePath));
      const turns = reads.get(skillName) ?? [];
      turns.push(turn.index);
      reads.set(skillName, turns);
    }
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Judge response schema
// ---------------------------------------------------------------------------

const SKILL_STATUSES = ['used', 'partial', 'missed'] as const;
type SkillStatus = (typeof SKILL_STATUSES)[number];

interface JudgedSkill {
  skill: string;
  status: SkillStatus;
  turn: number;
  note: string;
}

interface SkillUtilizationResponse {
  skills: JudgedSkill[];
  advice: string[];
}

const responseSchema: SchemaLike<SkillUtilizationResponse> = {
  parse(input: unknown): SkillUtilizationResponse {
    const root = expectRecord(input, 'response');
    const rawSkills = root['skills'];
    const skills =
      rawSkills === undefined || rawSkills === null
        ? []
        : expectArray(rawSkills, 'skills').map((item, i): JudgedSkill => {
            const record = expectRecord(item, `skills[${i}]`);
            return {
              skill: expectString(record['skill'], `skills[${i}].skill`),
              status: expectEnum(record['status'], `skills[${i}].status`, SKILL_STATUSES),
              turn: expectTurnNumber(record['turn'], `skills[${i}].turn`),
              note: expectString(record['note'], `skills[${i}].note`),
            };
          });
    return { skills, advice: parseAdvice(root['advice'], 'advice') };
  },
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function formatInventoryBlock(skills: readonly InstalledSkill[]): string {
  const lines = skills.map(
    (skill) => `- ${skill.name}: ${skill.description.length > 0 ? skill.description : '(no description)'}`,
  );
  return `Installed skills on this machine (name: description):\n${lines.join('\n')}`;
}

function formatReadsBlock(reads: ReadonlyMap<string, number[]>): string {
  if (reads.size === 0) {
    return 'Skill reads detected in the transcript (Read calls on SKILL.md files): none';
  }
  const lines = [...reads.entries()].map(
    ([name, turns]) => `- ${name} (read at turn${turns.length > 1 ? 's' : ''} ${turns.join(', ')})`,
  );
  return `Skill reads detected in the transcript (Read calls on SKILL.md files):\n${lines.join('\n')}`;
}

function buildPrompt(
  session: Session,
  inventory: readonly InstalledSkill[],
  reads: ReadonlyMap<string, number[]>,
): string {
  return [
    CODING_SESSION_PREAMBLE,
    'Metric: SKILL UTILIZATION — agents have installed "skills" (reusable instruction documents named SKILL.md) that they are expected to read and follow when a task matches a skill\'s purpose. Did this agent use the relevant installed skills?',
    formatInventoryBlock(inventory),
    formatReadsBlock(reads),
    'Caveat: the inventory was scanned from the machine as it is NOW; the transcript does not record which skills existed when the session ran. If the session predates a skill being plausible (or the work clearly could not have known about it), lean towards excluding that skill rather than marking it missed.',
    [
      'Assess:',
      "Step 1 — From the inventory, identify the skills that plausibly SHOULD have triggered for this session's tasks. Be conservative: include a skill only when its description clearly matches work the user requested or the agent actually performed. Most sessions match zero or a few skills; do NOT stretch descriptions to fit.",
      'Step 2 — For each such skill, judge:',
      '- "used": its SKILL.md was read (see the detected reads above) AND the agent visibly followed its guidance afterwards.',
      '- "partial": its SKILL.md was read, but the guidance was then ignored or only superficially followed.',
      '- "missed": it should have triggered but its SKILL.md was never read.',
      'The score is computed from your statuses in code (used = 1, partial = 0.5, missed = 0, averaged); do not output a score.',
    ].join('\n'),
    jsonFormatSpec(
      `{
  "skills": [ { "skill": string, "status": "used" | "partial" | "missed", "turn": number, "note": string } ],
  "advice": [string]
}`,
      [
        '"skill" must exactly match a name from the installed-skill inventory above.',
        '"turn" is the most relevant turn: where the skill was read (used/partial) or where it should have triggered (missed).',
        '"note" explains the evidence in 1-2 sentences with turn citations; it is displayed underneath the skill name, so do NOT restate the name inside it.',
        'If none of the installed skills apply to this session, return an empty "skills" array.',
        '"advice" targets the AGENT: how to notice and apply relevant skills better on this kind of task (or, if all applicable skills were used well, how to keep doing so).',
      ],
    ),
    buildSessionBlock(session),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Metric
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<SkillStatus, number> = { missed: 0, partial: 1, used: 2 };
const STATUS_POINTS: Record<SkillStatus, number> = { used: 1, partial: 0.5, missed: 0 };

export const skillUtilizationMetric: Metric = {
  id: 'skill-utilization',
  version: 1,
  name: 'Skill Utilization',
  description:
    'Scans installed agent skills and scores whether the ones relevant to this session were read and actually followed.',
  target: 'agent',
  async evaluate(session: Session, judge: Judge): Promise<MetricResult> {
    const inventory = capInventory(await scanInstalledSkills());

    // Short-circuit: with no skills installed (or none scannable), there is
    // nothing the agent could have utilized. Note this can differ from what
    // was installed when the session ran — see the module caveat.
    if (inventory.length === 0) {
      return {
        score: 1,
        findings: [
          {
            turnRef: 1,
            note:
              'No agent skills (SKILL.md files) are installed on this machine, so skill ' +
              'utilization is not applicable. (The inventory reflects the machine now, not ' +
              'necessarily when the session ran.)',
          },
        ],
        advice: [],
      };
    }

    const reads = detectSkillReads(session);
    const response = await judge.evaluate({
      prompt: buildPrompt(session, inventory, reads),
      schema: responseSchema,
    });
    const turnCount = session.turns.length;

    // Ground the verdicts: drop any skill name the judge invented, keeping
    // the inventory's canonical casing for the finding label.
    const canonicalNames = new Map(inventory.map((s) => [s.name.toLowerCase(), s.name]));
    const judged = response.skills.flatMap((item) => {
      const canonical = canonicalNames.get(item.skill.toLowerCase());
      return canonical === undefined ? [] : [{ ...item, skill: canonical }];
    });

    if (judged.length === 0) {
      // No installed skill was applicable: nothing to miss, full marks.
      return makeResult(
        1,
        [
          {
            turn: 1,
            note: `None of the ${inventory.length} installed skills applied to this session's tasks.`,
          },
        ],
        response.advice,
        turnCount,
      );
    }

    const points = judged.reduce((sum, item) => sum + STATUS_POINTS[item.status], 0);
    const ordered = [...judged].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    const findings: RawFinding[] = ordered.map((item) => ({
      turn: item.turn,
      label: item.skill,
      status: item.status,
      note: item.note,
    }));

    return makeResult(points / judged.length, findings, response.advice, turnCount);
  },
};
