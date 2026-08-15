/**
 * The tab composer: ONE judge call that turns the computed `InsightsReport`
 * into catalog-constrained view specs for the four interactive tabs.
 *
 * The judge only chooses layout and emphasis — every value in a spec is
 * bound by JSON Pointer into the report (enforced by the catalog's prop
 * schemas and prompt rules), so it cannot transcribe or mangle numbers. Each
 * tab in the response is validated independently (`normalizeTabSpec`); an
 * invalid or null tab silently falls back to the deterministic tab body, and
 * a judge failure falls back entirely.
 *
 * The prompt embeds the report JSON with `generatedAt` stripped, so an
 * unchanged report state produces a byte-identical prompt — the judge's disk
 * cache then makes recomposition free.
 */

import type { Spec } from '@json-render/react';

import { catalogComponentReference, normalizeTabSpec } from '../cli/ui/insights/catalog.js';
import type { Judge, SchemaLike } from '../judge/types.js';
import type { InsightsReport } from './types.js';

export const TAB_KEYS = ['overview', 'trends', 'leverage', 'hotspots'] as const;
export type TabKey = (typeof TAB_KEYS)[number];

/** One validated spec (or null = keep the deterministic body) per tab. */
export type InsightsTabSpecs = Record<TabKey, Spec | null>;

const responseSchema: SchemaLike<InsightsTabSpecs> = {
  parse(input: unknown): InsightsTabSpecs {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('expected a JSON object with keys "overview", "trends", "leverage", "hotspots"');
    }
    const record = input as Record<string, unknown>;
    return {
      overview: normalizeTabSpec(record['overview']),
      trends: normalizeTabSpec(record['trends']),
      leverage: normalizeTabSpec(record['leverage']),
      hotspots: normalizeTabSpec(record['hotspots']),
    };
  },
};

/** Stable report JSON for the prompt: `generatedAt` changes every run, drop it. */
function stableReportJson(report: InsightsReport): string {
  const { generatedAt: _generatedAt, ...stable } = report;
  return JSON.stringify(stable, null, 1);
}

function buildComposePrompt(report: InsightsReport): string {
  return [
    'You are composing the four tabs of a terminal dashboard that answers "am I getting better at working with my coding agent?". The data is a precomputed insights report (JSON below); you choose layout and emphasis by composing view specs from a fixed component catalog.',

    [
      'SPEC FORMAT — each tab is one spec:',
      '{ "root": "<element-key>", "elements": { "<element-key>": { "type": "<component>", "props": { ... }, "children": ["<child-key>", ...] } } }',
      '- "elements" is a flat map; parent/child structure comes only from the "children" arrays of element keys. Every referenced key must exist. Keys are short unique strings you invent.',
      '- Only "stack" and "section" render children; every other component must have "children": [].',
      '- The root element should be a "stack" or "section".',
    ].join('\n'),

    [
      'DATA BINDING — the single most important rule:',
      '- Every number and every piece of report text MUST be bound by JSON Pointer (RFC 6901) into the report JSON below, using {"$state": "/json/pointer"} as the prop value, or a {"$template": "... ${/json/pointer} ..."} string. NEVER copy report values into the spec as literals.',
      '- Array indices are part of the pointer, e.g. /deterministicTrends/1/latest or /hotspots/clusters/0/draft.',
      '- Labels, titles, subtitles, and captions are your own words — those are plain string literals.',
      '- Numbers resolve raw (e.g. 0.529); pick the right "format" so the renderer formats them.',
      '- In $template strings, interpolate only text and integer counts (session counts, dates). Never interpolate fractional numbers (scores, ratios, deltas) — they render as raw floats like 0.05918144085950999; route them through a value prop with a "format" instead.',
    ].join('\n'),

    `COMPONENT CATALOG:\n${catalogComponentReference()}`,

    `REPORT JSON:\n${stableReportJson(report)}`,

    [
      'COMPOSITION GUIDANCE:',
      '- Four tabs: "overview" (the verdict: lead with what changed and the answer to "am I getting better?"), "trends" (weekly movement), "leverage" (the composite and its decomposition), "hotspots" (repeated guidance and the ready-to-paste drafts).',
      '- Lead each tab with what changed or what matters most; put detail below.',
      '- Keep each tab within roughly 100 columns by 30 rows.',
      '- Respect the data\'s own caveats: surface report "notes", thin data, cohort breaks, and null values (a null headline means "not enough data") instead of hiding them.',
      '- For any tab where you cannot improve on a plain rendering, return null to keep the built-in view.',
    ].join('\n'),

    [
      'RESPONSE — a single JSON object, nothing else:',
      '{ "overview": <spec or null>, "trends": <spec or null>, "leverage": <spec or null>, "hotspots": <spec or null> }',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * Compose the four tab specs with one judge call. Returns null when the
 * judge call fails outright (every tab then renders deterministically);
 * individual invalid tabs come back as null inside the record.
 */
export async function composeTabs(
  report: InsightsReport,
  judge: Judge,
): Promise<InsightsTabSpecs | null> {
  try {
    return await judge.evaluate({ prompt: buildComposePrompt(report), schema: responseSchema });
  } catch {
    return null;
  }
}
