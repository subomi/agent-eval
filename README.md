# agent-evals

A TypeScript CLI that evaluates your local coding-agent sessions — **Cursor**,
**Claude Code**, and **Codex CLI** — using an LLM judge, stores every result
in a local SQLite database, and answers the question *"am I getting better at
working with my agent?"* — with per-session scores and advice, and
cross-session trends, a composite leverage score, and the guidance you keep
having to repeat.

## Session sources

| Agent | id | Local store | Notes |
| --- | --- | --- | --- |
| Cursor | `cursor` | `~/.cursor/projects/*/agent-transcripts` | Titles/recency joined from Cursor's search db; transcripts record no tool results |
| Claude Code | `claude-code` | `~/.claude/projects/*/` | Parsed via `@letta-ai/trajectory`; titles from the store's `ai-title` rows; tool results incl. error status |
| Codex | `codex` | `~/.codex/sessions/` | Parsed via `@letta-ai/trajectory`; titles from the first user message; tool results; injected `AGENTS.md`/`environment_context` blobs stripped from user text |

Every command takes `--agents <ids|all>` (comma-separated ids). The default
comes from `[agents].enabled` in config.toml; when that is unset too, "all"
means every source whose local store exists on this machine. Multi-source
listings interleave by recency and show an extra agent column.

## Requirements

- Node.js >= 22.5 (uses the builtin `node:sqlite`; no native SQLite build)
- pnpm
- One LLM provider API key for judge calls (see [Configuration](#configuration))

## First run

```bash
pnpm install
pnpm build
```

1. **Add an API key.** On its first run, any judging command writes a
   commented template to `~/.agent-evals/config.toml` and points you at it:

   ```bash
   agent-evals batch --dry-run   # creates the template, then asks for a key
   ```

   Put a provider key under `[providers]`:

   ```toml
   [providers]
   anthropic_api_key = "sk-ant-..."
   ```

2. **Preview the work.** See what a batch would evaluate — zero judge calls:

   ```bash
   agent-evals batch --dry-run --min-turns 4 --limit 20
   ```

3. **Evaluate.** Run the batch for real. Results are written per metric as
   they finish, so an interrupted run resumes where it stopped, and
   re-running is free (already-evaluated pairs are served from the DB):

   ```bash
   agent-evals batch --min-turns 4 --limit 20
   ```

4. **Look at the trends.**

   ```bash
   agent-evals insights
   ```

`agent-evals` here means the built binary (`pnpm build` + linked bin) —
during development `pnpm dev <command>` runs the same thing from source.

## Commands

Final artifacts (reports, tables, `--json`) go to **stdout**; all progress
and interaction goes to **stderr** — piping stdout stays clean.

### `agent-evals [eval]` (default)

Evaluate one session: an interactive picker on a TTY, or `--session` to skip
it. A session is just a batch of one — results land in the same DB with the
same idempotency rules.

The `--session` ref is resolved across the active sources; in the unlikely
case a ref matches sessions in more than one source, the command errors and
asks you to narrow with `--agents`.

| Flag | Meaning |
| --- | --- |
| `--session, -s <ref>` | session uuid or path to a transcript `.jsonl`; skips the picker |
| `--agents <ids|all>` | agent sources to use (`cursor`, `claude-code`, `codex`; default: `[agents].enabled`, else all available) |
| `--model, -m <ref>` | judge model `"provider/model-id"` (default: pinned model in config.toml, else auto-picked and pinned) |
| `--metrics <ids>` | run only these metrics (comma-separated ids) |
| `--limit, -n <n>` | max sessions offered in the picker (default 15) |
| `--force` | re-evaluate even when results already exist |
| `--no-cache` | bypass the judge response cache |
| `--json` | emit the run record JSON to stdout instead of the report |

### `agent-evals list`

Recent sessions across the active sources, newest first, with an
"evaluated?" column sourced from the DB (and an agent column when more than
one source is active).

| Flag | Meaning |
| --- | --- |
| `--limit, -n <n>` | max sessions to list (default 15) |
| `--project <slug>` | only sessions from this project |
| `--agents <ids|all>` | agent sources to list (see `eval`) |

### `agent-evals batch`

Evaluate many sessions through the shared idempotent pipeline. A
(content-hash, metric, metric-version, judge-model) pair is evaluated at
most once; a session edited after evaluation re-evaluates as new work. The
directive extractor runs alongside the metrics (see
[Directive extraction](#directive-extraction)).

| Flag | Meaning |
| --- | --- |
| `--dry-run` | print the work plan (run vs cached per session) and exit — no judge calls |
| `--force` | re-evaluate metric pairs that already have results |
| `--min-turns <n>` | skip sessions with fewer turns (default 3) |
| `--since <date>` | only sessions updated on/after this date (e.g. `2026-08-01`) |
| `--limit, -n <n>` | evaluate at most n sessions (most recent first) |
| `--project <slug>` | only sessions from this project |
| `--agents <ids|all>` | agent sources to scan (see `eval`) |
| `--metrics <ids>` | run only these metrics (comma-separated ids) |
| `--model, -m <ref>` | judge model `"provider/model-id"` |
| `--no-cache` | bypass the judge response cache |

### `agent-evals insights`

Everything is computed at read time from the DB — nothing aggregated is
stored, so formulas can change freely.

On a TTY, `insights` launches an **interactive tabbed app** that stays
mounted until you quit; when stdout is piped (or with `--static`) it prints
the one-shot 80-column report instead, and `--json` emits the raw computed
report.

Keybindings:

| Keys | Action |
| --- | --- |
| `←`/`→` or `h`/`l` | cycle tabs |
| `1`–`4` | jump to a tab |
| `↑`/`↓` or `j`/`k` | select a hotspot cluster (deterministic Hotspots tab) |
| `q` / `Esc` / `Ctrl-C` | quit |

The four tabs (also the four sections of the static report, which leads
with a plain-language summary — the answer to "am I getting better?", also
in `--json` as `summary`):

1. **Overview** — the verdict: summary lines, the leverage headline with
   its delta, the biggest week-over-week movers, and the top hotspot.
2. **Trends** — deterministic trends (steering rate, median turns/session,
   tool-failure rate, repeated-tool-call rate; weekly ISO buckets with
   sparklines and `better` / `worse` / `steady` arrows — judge-free,
   noise-free longitudinal signals) and judged trends (per-metric weekly
   median score, split by target `user` / `agent` / `collab`, with **cohort
   breaks** wherever the metric version or judge model changed — scores are
   never averaged across cohorts). Sparkline heights are anchored (judged
   scores to the fixed 0–1 scale, deterministic series from zero) and long
   empty stretches compress to a `┄N┄` N-week-gap marker, so sparse history
   stays legible.
3. **Leverage** — each session's metric score is percentile-ranked against
   your own full history for that metric, then combined with weights from
   `[insights.weights]` (built-in defaults fill the gaps). Headline is the
   recent-4-weeks weighted mean (50/100 = your typical historical session),
   with a full decomposition table and a 4-week delta.
4. **Hotspots** — all extracted directives are clustered into themes by a
   single judge call (disk-cached); reports the repetition rate (share of
   sessions containing guidance you already gave elsewhere), clusters with
   example quotes and session counts, and a suggested durable artifact per
   cluster (Cursor rule / AGENTS.md line / skill / prompt template) with
   ready-to-paste draft text. Interactively this is a master/detail list;
   the static report prints a compact dump.

Thin data is reported as such (single-week histories, few sessions, no
directives) instead of rendering misleading trends.

**Composed tabs.** By default the interactive view also asks the judge to
*compose* the tabs: one extra judge call returns a layout spec per tab built
from a fixed catalog of display components, with every value bound by JSON
Pointer into the computed report — the judge chooses layout and emphasis but
can never transcribe (or mangle) a number. Composed tabs are marked `✦` in
the footer. The call rides the same disk cache as every other judge call,
keyed on the report content, so an unchanged report recomposes for free.
Anything that goes wrong — no API key, a judge error, an invalid spec —
silently falls back to the deterministic tab bodies shown by `--plain`.
Composition never touches the static report or the piped output, and can be
disabled per run (`--plain`) or permanently (`[insights] compose = false` in
config.toml; the flag wins over config).

| Flag | Meaning |
| --- | --- |
| `--since <date>` | only sessions updated on/after this date |
| `--project <slug>` | only sessions from this project |
| `--agents <ids|all>` | only stored sessions from these agents (`all` = no filter, so sessions from removed stores stay in scope) |
| `--static` | print the one-shot report instead of the interactive tabs (always used when stdout is not a terminal) |
| `--plain` | skip judge tab composition; deterministic tabs only |
| `--json` | emit the full computed report as JSON to stdout, plus `viewSpec` (the composed per-tab specs, or `null` when composition is off or failed) |

## Metrics

Seven metrics, each scored 0–1 with turn-cited evidence and 1–3 pieces of
concrete advice. The id is what `--metrics` accepts; the target says who the
feedback is aimed at.

| Metric | id | Target | What it judges |
| --- | --- | --- | --- |
| Goal Completion | `goal-completion` | agent | Extracts the user's intents and judges how many were satisfied by session end (partial credit 0.5). |
| Instruction Adherence | `instruction-adherence` | agent | Extracts the user's explicit constraints and scores the ratio the agent respected, citing violations. |
| Tool Efficiency | `tool-efficiency` | agent | How purposefully the agent used tools — deterministic repeat/failure signals plus judged thrash. |
| Skill Utilization | `skill-utilization` | agent | Scans installed agent skills (SKILL.md files) and scores whether the relevant ones were read and actually followed. |
| Prompt Quality | `prompt-quality` | user | Scores your initial prompt on goal clarity, context/constraint completeness, and definition of done, using how much the agent had to guess as evidence. |
| Steering Grounding | `steering-grounding` | user | Classifies each steering episode as grounded / vague / misleading and your mode as augmentative vs delegative; evidence-backed steering and examined acceptance score high. |
| Conversation Efficiency | `conversation-efficiency` | collab | Rework loops, wasted turns, and whether turns-to-resolution matched the size of the task. |

Caveat on Skill Utilization: transcripts don't record the system prompt, so
the skill inventory is scanned from the machine *now* — it may differ from
what was installed when the session ran.

### Directive extraction

Not a scored metric: a per-session judge pass (`src/extract/directives.ts`)
that extracts durable directives you gave the agent — standing instructions
("always use pnpm"), preferences ("don't add comments"), and corrections
that imply a standing rule. One-off task instructions are excluded. Rows are
stored in the `directives` table, versioned by extractor version and
idempotent per transcript state, and feed the insights repetition-hotspots
section.

## Files (`~/.agent-evals/`)

| Path | Contents |
| --- | --- |
| `agent-evals.db` | SQLite source of truth (WAL): `sessions` (stats per session), `metric_results` (one row per content-hash + metric + metric-version + judge-model — the idempotency key), `directives`, `meta` |
| `config.toml` | provider API keys, pinned judge model, composite weights |
| `cache/` | judge responses keyed by (model, prompt, schema) — re-evaluating an unchanged session is free even with `--force`; disable per run with `--no-cache` |

## Configuration

`~/.agent-evals/config.toml` is the single config surface (a commented
template is written on first run):

```toml
[providers]
# lowercase form of the provider env var; any of:
# anthropic_api_key, openai_api_key, gemini_api_key, openrouter_api_key,
# xai_api_key, groq_api_key, mistral_api_key, deepseek_api_key
anthropic_api_key = "sk-ant-..."

[judge]
# Pinned automatically on the first successful run so longitudinal scores
# stay comparable; pass --model to override for one run.
model = "anthropic/claude-sonnet-4-5"

[insights]
# Judge-composed interactive tabs (default true). false = always render the
# deterministic tabs, same as passing --plain.
compose = true

[insights.weights]
# Optional per-metric weights for the Agent Leverage composite; metrics
# without an entry use the built-in defaults.
goal-completion = 0.25
tool-efficiency = 0.15

[agents]
# Which agents' sessions commands use when --agents is absent. "all" (the
# default when unset) means every source whose local store exists.
# Valid ids: cursor, claude-code, codex. The --agents flag wins over this.
enabled = ["cursor", "claude-code", "codex"]
```

**Precedence: real environment variables always win** over `[providers]`
values (`ANTHROPIC_API_KEY` in the shell beats `anthropic_api_key` in the
file), so CI and one-off overrides keep working. Key values are never
printed. There is no `.env` loading — the config file replaced it.

The judge model resolves as: `--model` flag > `[judge].model` > auto-pick
(preferring frontier Anthropic/OpenAI models among providers with a key);
an auto-picked model is pinned back into the file.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # compile to dist/
pnpm dev         # run src/cli/index.ts with tsx (pnpm dev batch --dry-run, ...)
```

## Architecture

```
CursorSource ──┐
ClaudeCode  ───┼─→ EvalPipeline ─→ PiJudge (+ disk cache)
Codex       ───┘        │
 (source registry)      ▼
                 agent-evals.db  ─→ insights (read-time computation)
```

- `src/model/session.ts` — normalized `Session` / `Turn` / `ToolCall` types,
  deterministic derived stats, long-session truncation/rendering utilities.
- `src/adapters/cursor.ts` — lists and parses Cursor transcripts from
  `~/.cursor/projects/*/agent-transcripts`, joined with titles/recency from
  Cursor's `conversation-search.db` (read-only, graceful fallbacks);
  computes each session's `contentHash`.
- `src/adapters/trajectory.ts` — Claude Code and Codex sources on
  `@letta-ai/trajectory` (store listing + transcript normalization), with a
  shared folder that turns the library's flat record stream into
  role-alternating turns: assistant turns carry their tool calls, tool
  results attach to the originating call (with error status), reasoning
  records are skipped, and Codex's injected `AGENTS.md`/environment-context
  blobs are stripped from user text.
- `src/adapters/index.ts` — the source registry: all sources by id plus the
  availability helper behind `--agents all`.
- `src/judge/` — LLM judge on `@earendil-works/pi-ai`: model auto-pick,
  JSON-constrained responses with validation and one retry, disk cache,
  bounded concurrency.
- `src/metrics/` — the seven-metric library; each combines an optional
  deterministic pre-pass with judge calls and returns
  `{ score, findings, advice }`.
- `src/extract/directives.ts` — the directive extractor (versioned, pure;
  persistence happens in the pipeline).
- `src/pipeline/evaluate.ts` — the shared idempotent engine used by `eval`
  and `batch`: plans work against the DB, runs only missing metric pairs,
  writes per metric as each completes (crash-safe resume), runs the
  directive extractor when missing.
- `src/store/` — `db.ts` (SQLite schema + row access) and `config.ts`
  (config.toml parsing, provider-env application, judge-model pinning).
- `src/insights/` — read-time analytics: ISO-week helper, deterministic and
  judged weekly trends with cohort splitting, the percentile-normalized
  Agent Leverage composite, hotspot clustering, and the tab composer
  (`compose.ts`: one cached judge call returning catalog-constrained view
  specs with JSON-Pointer data bindings).
- `src/cli/commands/` — one thin module per subcommand (parse → pipeline →
  component).
- `src/cli/ui/` — Ink components: picker, live progress, report, batch
  tables, and the insights views (interactive tab app, static artifact, and
  the json-render component catalog/registry in `insights/catalog.tsx`).
  Progress renders to stderr; final artifacts render once to stdout via
  `<Static>`.
