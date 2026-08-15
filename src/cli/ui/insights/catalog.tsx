/**
 * The judge-composable component catalog for the insights tabs, plus its Ink
 * registry and the `SpecTabView` wrapper that renders a composed spec.
 *
 * The catalog is the judge's entire vocabulary: nine display-only components
 * (no actions), each described with an explicit data-binding rule — every
 * value that comes from the report must be bound by JSON Pointer
 * (`{"$state": "/composite/headline"}`) or `$template` interpolation, never
 * transcribed. The judge chooses layout and emphasis; it cannot mangle
 * numbers because raw values are resolved from the report at render time and
 * formatted here in the registry.
 *
 * `catalogComponentReference()` renders the same definitions as a compact
 * prompt listing (descriptions + JSON Schema of each props shape), so the
 * composer prompt in `src/insights/compose.ts` can never drift from what the
 * renderer accepts.
 */

import { defineCatalog, validateSpec } from '@json-render/core';
import {
  ActionProvider,
  defineRegistry,
  Renderer,
  schema,
  StateProvider,
  VisibilityProvider,
  type Spec,
} from '@json-render/react';
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { createContext, useContext } from 'react';
import { z } from 'zod';

import type { InsightsReport, WeekPoint } from '../../../insights/index.js';
import { singleLine, wrapText } from '../../format.js';
import { scoreBarText, scoreColor, type InkColor } from '../theme.js';
import { compressedSpark, pct1, points, signedPoints } from './shared.js';

export type { Spec };

// ---------------------------------------------------------------------------
// Dynamic-value prop schemas: pointers into the report, template strings, or
// (where allowed) plain literals
// ---------------------------------------------------------------------------

const BINDING_RULE =
  'Bind every value that exists in the report by JSON Pointer — never transcribe numbers or report text into the spec.';

const statePointer = z
  .object({ $state: z.string() })
  .describe('JSON Pointer binding into the report, e.g. {"$state": "/composite/headline"}');

const templateString = z
  .object({ $template: z.string() })
  .describe(
    'String with ${/json/pointer} interpolations resolved against the report, e.g. {"$template": "ending ${/composite/recentWindow/end}"}',
  );

/** A display string: a pointer, a template, or the judge's own literal words. */
const dynString = z.union([statePointer, templateString, z.string()]);

/** A display value: report-bound values MUST use the pointer form. */
const dynValue = z.union([statePointer, templateString, z.string(), z.number(), z.null()]);

const valueFormat = z.enum(['percent', 'points', 'signed-points', 'score', 'count', 'text']);
type ValueFormat = z.infer<typeof valueFormat>;

const FORMAT_LEGEND =
  'format semantics for raw report numbers: "percent" = 0..1 ratio -> "25.8%"; "points" = 0..1 percentile -> "53"; ' +
  '"signed-points" = 0..1 delta -> "+6"; "score" = 0..1 score -> "0.85"; "count" = plain number -> "16.5"; "text" = String(value).';

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const insightsCatalog = defineCatalog(schema, {
  components: {
    stack: {
      description:
        'Vertical layout container — the usual root element. Renders children top to bottom; gap inserts blank lines between them. One of only two components that render children (the other is section).',
      props: z.object({ gap: z.number().int().min(0).max(2).optional() }),
      slots: ['default'],
    },
    section: {
      description:
        'Titled group: bold title with a dim subtitle on the same line, children indented beneath. Title and subtitle are your own words (plain strings). Renders children.',
      props: z.object({ title: z.string(), subtitle: z.string().optional() }),
      slots: ['default'],
    },
    statRow: {
      description:
        `One labelled statistic: dim label column, formatted value, optional dim hint after it. ${BINDING_RULE} ` +
        `${FORMAT_LEGEND} tone colors the value: "good" green, "bad" red; omit for neutral.`,
      props: z.object({
        label: z.string(),
        value: dynValue,
        format: valueFormat.optional(),
        hint: dynString.optional(),
        tone: z.enum(['good', 'bad', 'neutral']).optional(),
      }),
    },
    sparkline: {
      description:
        'Weekly sparkline over true calendar weeks (gaps compress to a ┄N┄ marker). weeks MUST be a JSON Pointer to a weeks array from the report (e.g. {"$state": "/deterministicTrends/0/weeks"} or "/judgedTrends/2/cohorts/0/weeks") — the glyphs are rendered from the raw data, never write them yourself. domain "unit" anchors heights to the 0–1 score scale (use for judged scores); "auto" (default) scales from zero.',
      props: z.object({
        label: z.string(),
        weeks: statePointer,
        domain: z.enum(['unit', 'auto']).optional(),
        caption: dynString.optional(),
      }),
    },
    scoreBar: {
      description:
        `Horizontal 0–1 bar (█░ glyphs) with the value as 0–100 points, colored red/yellow/green by the value. ${BINDING_RULE} value must resolve to a number between 0 and 1.`,
      props: z.object({
        label: z.string(),
        value: z.union([statePointer, z.number()]),
        caption: dynString.optional(),
      }),
    },
    table: {
      description:
        `Compact table: columns are your own header labels; rows are arrays of cells, one per column. ${BINDING_RULE} ` +
        `Cells bound with {"$state": pointer} resolve to raw report values; formats (one entry per column, same order) formats them — ${FORMAT_LEGEND} ` +
        'Columns with a non-"text" format are right-aligned. null/missing cells render as "—".',
      props: z.object({
        columns: z.array(z.string()).min(1),
        formats: z.array(valueFormat).optional(),
        rows: z.array(z.array(dynValue)).min(1),
      }),
    },
    callout: {
      description:
        'Emphasized note with a colored ▌ gutter: tone "info" cyan, "success" green, "warning" yellow, "danger" red. Text may be a plain string or a $template interpolating report pointers.',
      props: z.object({
        tone: z.enum(['info', 'success', 'warning', 'danger']),
        text: dynString,
      }),
    },
    quote: {
      description:
        'Verbatim quotation in “smart quotes”, wrapped, with an optional dim attribution. Bind text by pointer when quoting the report (e.g. a directive example at /hotspots/clusters/0/examples/0).',
      props: z.object({ text: dynString, source: dynString.optional() }),
    },
    draftBlock: {
      description:
        'Multiline ready-to-paste draft text behind a cyan "draft │" gutter (label overrides the gutter word). Bind text by pointer when showing a report draft (e.g. /hotspots/clusters/0/draft).',
      props: z.object({ text: dynString, label: z.string().optional() }),
    },
  },
  actions: {},
});

/**
 * The prompt listing for the composer: every component with its description
 * and the JSON Schema of its props, generated from the same zod schemas the
 * validator uses.
 */
export function catalogComponentReference(): string {
  const lines: string[] = [];
  for (const [name, def] of Object.entries(insightsCatalog.data.components)) {
    const propsSchema = z.toJSONSchema(def.props as z.ZodType) as Record<string, unknown>;
    delete propsSchema['$schema'];
    lines.push(`- "${name}": ${def.description ?? ''}`);
    lines.push(`  props JSON Schema: ${JSON.stringify(propsSchema)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Spec normalization + validation (shared with the composer)
// ---------------------------------------------------------------------------

/**
 * Turn one judge-produced candidate spec into a validated `Spec`, or null
 * when it is unusable (the caller falls back to the deterministic tab body).
 *
 * Three passes: default-fill `visible: true` and `children: []` (required by
 * `catalog.validate()` on every element), then the catalog's structural zod
 * validation plus core's `validateSpec` (root/children integrity), then
 * per-element props validation against each component's own zod schema —
 * the catalog-wide validator cannot check props per component type (with
 * multiple components `propsOf` compiles to a loose record), so this last
 * pass is what actually rejects wrong-shaped props.
 */
export function normalizeTabSpec(value: unknown): Spec | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = structuredClone(value) as { root?: unknown; elements?: unknown };
  if (typeof candidate.root !== 'string') return null;
  if (candidate.elements === null || typeof candidate.elements !== 'object') return null;
  for (const element of Object.values(candidate.elements as Record<string, unknown>)) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) return null;
    const record = element as Record<string, unknown>;
    record['visible'] ??= true;
    record['children'] ??= [];
  }

  const result = insightsCatalog.validate(candidate);
  if (!result.success || result.data === undefined) return null;
  const spec = result.data as unknown as Spec;
  if (!validateSpec(spec).valid) return null;

  const components = insightsCatalog.data.components as Record<
    string,
    { props: z.ZodType } | undefined
  >;
  for (const element of Object.values(spec.elements)) {
    const definition = components[element.type];
    if (definition === undefined) return null;
    if (!definition.props.safeParse(element.props).success) return null;
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Runtime coercion of resolved prop values (pointers may resolve to anything)
// ---------------------------------------------------------------------------

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const n = asNumber(value);
  return n === null ? null : String(n);
}

function asWeeks(value: unknown): WeekPoint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ok = value.every(
    (w) =>
      w !== null &&
      typeof w === 'object' &&
      typeof (w as WeekPoint).weekStart === 'string' &&
      typeof (w as WeekPoint).value === 'number',
  );
  return ok ? (value as WeekPoint[]) : null;
}

function formatDisplay(value: unknown, format: ValueFormat | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = asNumber(value);
  if (n === null) return String(value);
  switch (format ?? 'text') {
    case 'percent':
      return pct1(n);
    case 'points':
      return points(n);
    case 'signed-points':
      return signedPoints(n);
    case 'score':
      return n.toFixed(2);
    case 'count':
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
    case 'text':
      return String(n);
  }
}

// ---------------------------------------------------------------------------
// The Ink registry
// ---------------------------------------------------------------------------

/** Character budget for the composed tab body, provided by `SpecTabView`. */
const SpecWidthContext = createContext<number>(80);

const LABEL_WIDTH = 26;
const BAR = 12;
const MAX_CELL = 36;

function Label({ text, dim }: { text: string; dim?: boolean }): ReactElement {
  return (
    <Box width={LABEL_WIDTH} flexShrink={0}>
      <Text dimColor={dim === true}>{singleLine(text, LABEL_WIDTH - 1)}</Text>
    </Box>
  );
}

export const { registry: insightsRegistry } = defineRegistry(insightsCatalog, {
  components: {
    stack: ({ props, children }) => (
      <Box flexDirection="column" gap={props.gap ?? 0}>
        {children}
      </Box>
    ),

    section: ({ props, children }) => (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text bold>{props.title}</Text>
          {props.subtitle !== undefined && <Text dimColor>{`   ${props.subtitle}`}</Text>}
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          {children}
        </Box>
      </Box>
    ),

    statRow: ({ props }) => {
      const tone: InkColor | undefined =
        props.tone === 'good' ? 'green' : props.tone === 'bad' ? 'red' : undefined;
      const hint = props.hint === undefined ? null : asString(props.hint);
      return (
        <Box>
          <Label text={String(props.label)} dim />
          <Box flexShrink={0}>
            <Text bold {...(tone !== undefined ? { color: tone } : {})}>
              {formatDisplay(props.value, props.format)}
            </Text>
          </Box>
          {hint !== null && <Text dimColor>{`  ${hint}`}</Text>}
        </Box>
      );
    },

    sparkline: ({ props }) => {
      const width = useContext(SpecWidthContext);
      const weeks = asWeeks(props.weeks);
      const budget = Math.min(60, Math.max(24, width - LABEL_WIDTH - 16));
      const caption = props.caption === undefined ? null : asString(props.caption);
      return (
        <Box>
          <Label text={String(props.label)} />
          <Box flexShrink={0}>
            {weeks === null ? (
              <Text dimColor>—</Text>
            ) : (
              <Text color="cyan">
                {compressedSpark(weeks, {
                  maxChars: budget,
                  ...(props.domain === 'unit' ? { domain: { min: 0, max: 1 } } : {}),
                })}
              </Text>
            )}
          </Box>
          {caption !== null && <Text dimColor>{`  ${caption}`}</Text>}
        </Box>
      );
    },

    scoreBar: ({ props }) => {
      const value = asNumber(props.value);
      const caption = props.caption === undefined ? null : asString(props.caption);
      const clamped = value === null ? null : Math.min(1, Math.max(0, value));
      return (
        <Box>
          <Label text={String(props.label)} />
          <Box flexShrink={0}>
            {clamped === null ? (
              <Text dimColor>—</Text>
            ) : (
              <Text>
                <Text color={scoreColor(clamped)}>{scoreBarText(clamped, BAR)}</Text>
                <Text bold>{points(clamped).padStart(4)}</Text>
              </Text>
            )}
          </Box>
          {caption !== null && <Text dimColor>{`  ${caption}`}</Text>}
        </Box>
      );
    },

    table: ({ props }) => {
      const columns = Array.isArray(props.columns) ? props.columns.map(String) : [];
      const formats = props.formats;
      const rows = Array.isArray(props.rows) ? props.rows : [];
      const cells = rows.map((row) =>
        columns.map((_, c) =>
          singleLine(formatDisplay(Array.isArray(row) ? row[c] : undefined, formats?.[c]), MAX_CELL),
        ),
      );
      const widths = columns.map((header, c) =>
        Math.min(MAX_CELL, Math.max(header.length, ...cells.map((row) => row[c]!.length))),
      );
      const numeric = columns.map((_, c) => formats?.[c] !== undefined && formats[c] !== 'text');
      const pad = (text: string, c: number): string =>
        numeric[c] === true ? text.padStart(widths[c]!) : text.padEnd(widths[c]!);
      return (
        <Box flexDirection="column">
          <Text dimColor>{columns.map((header, c) => pad(header.toUpperCase(), c)).join('  ')}</Text>
          {cells.map((row, i) => (
            <Text key={i}>{row.map((text, c) => pad(text, c)).join('  ')}</Text>
          ))}
        </Box>
      );
    },

    callout: ({ props }) => {
      const width = useContext(SpecWidthContext);
      const color: InkColor =
        props.tone === 'success'
          ? 'green'
          : props.tone === 'warning'
            ? 'yellow'
            : props.tone === 'danger'
              ? 'red'
              : 'cyan';
      const text = asString(props.text) ?? '';
      return (
        <Box flexDirection="column">
          {wrapText(text, Math.max(20, width - 6)).map((line, i) => (
            <Box key={i}>
              <Text color={color}>{'▌ '}</Text>
              <Text>{line}</Text>
            </Box>
          ))}
        </Box>
      );
    },

    quote: ({ props }) => {
      const width = useContext(SpecWidthContext);
      const text = (asString(props.text) ?? '').replace(/\s+/g, ' ').trim();
      const source = props.source === undefined ? null : asString(props.source);
      return (
        <Box flexDirection="column">
          {wrapText(`“${text}”`, Math.max(20, width - 6)).map((line, i) => (
            <Box key={i}>
              <Text>{line}</Text>
            </Box>
          ))}
          {source !== null && <Text dimColor>{`  — ${source}`}</Text>}
        </Box>
      );
    },

    draftBlock: ({ props }) => {
      const width = useContext(SpecWidthContext);
      const label = props.label ?? 'draft';
      const gutterFirst = `${label} │ `;
      const gutterRest = `${' '.repeat(label.length)} │ `;
      const bodyWidth = Math.max(20, width - 6 - gutterFirst.length);
      const lines = (asString(props.text) ?? '')
        .split('\n')
        .flatMap((line) => (line.trim().length === 0 ? [''] : wrapText(line, bodyWidth)));
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Box key={i}>
              <Text color="cyan">{i === 0 ? gutterFirst : gutterRest}</Text>
              <Text>{line}</Text>
            </Box>
          ))}
        </Box>
      );
    },
  },
});

// ---------------------------------------------------------------------------
// The composed tab body
// ---------------------------------------------------------------------------

/**
 * Render a validated composed spec: the three mandatory json-render
 * providers (state seeded with the report so `$state` pointers resolve),
 * then the Renderer over our Ink registry. Per-element error boundaries
 * inside the Renderer render null on failure, so a bad element degrades to
 * a blank line rather than a crash.
 */
export function SpecTabView({
  spec,
  report,
  width,
}: {
  spec: Spec;
  report: InsightsReport;
  width: number;
}): ReactElement {
  return (
    <SpecWidthContext.Provider value={width}>
      <StateProvider initialState={report as unknown as Record<string, unknown>}>
        <VisibilityProvider>
          <ActionProvider handlers={{}}>
            <Box flexDirection="column" width={width}>
              <Renderer spec={spec} registry={insightsRegistry} />
            </Box>
          </ActionProvider>
        </VisibilityProvider>
      </StateProvider>
    </SpecWidthContext.Provider>
  );
}
