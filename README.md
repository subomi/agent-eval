# agent-evals

A TypeScript CLI that evaluates local coding-agent sessions (starting with
Cursor) using an LLM judge, and reports per-metric scores plus concrete
improvement advice — both for how the agent executed and for how *you*
prompted it.

## Requirements

- Node.js >= 22.5 (uses the builtin `node:sqlite` to read Cursor's
  conversation index — no native SQLite dependency)
- pnpm
- At least one LLM provider API key for judge calls (see below)

## Setup

```bash
pnpm install
pnpm build
```

Put a provider API key in the environment, or in a `.env.local` / `.env` file
in the working directory (loaded at startup; existing environment variables
always win). Supported keys include:

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`

The judge model is auto-picked from providers that have a key configured
(preferring frontier Anthropic/OpenAI models); pass `--model` to override.

## Usage

```bash
# Interactive: pick a recent Cursor session, run all metrics, get a report
agent-evals            # or: pnpm dev

# List recent sessions (id, age, turn count, project, title) and exit
agent-evals --list

# Evaluate a specific session non-interactively (uuid from --list, or a
# transcript .jsonl path)
agent-evals --session b6ffcfb3-a917-4869-95e8-4ed3cca68f17
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--list` | print recent sessions and exit |
| `--session, -s <ref>` | session uuid or transcript path; skips the picker |
| `--model, -m <ref>` | judge model as `"provider/model-id"` (e.g. `anthropic/claude-sonnet-4-5`) |
| `--limit, -n <n>` | max sessions to list / offer in the picker (default 15) |
| `--no-cache` | bypass the judge response cache |
| `--json` | emit the run JSON to stdout instead of the pretty report |
| `--help, -h` | usage |

The pretty report (or `--json` output) goes to stdout; all progress and
interaction goes to stderr, so piping stdout stays clean.

### Metrics

Five v1 metrics, each scored 0–1 with turn-cited evidence and advice:

- **Goal Completion** `[agent]` — were the user's intents satisfied by session end?
- **Instruction Adherence** `[agent]` — were explicit user constraints respected?
- **Tool Efficiency** `[agent]` — deterministic signals + judged tool-call thrash
- **Prompt Quality** `[user]` — goal/context/constraint completeness of your prompts
- **Conversation Efficiency** `[collab]` — rework loops, turns-to-resolution

### Files

- `~/.agent-evals/runs/<session-id>-<epoch-ms>.json` — one versioned JSON
  record per eval run (`schemaVersion`, session info, judge model, session
  stats, per-metric scores/findings/advice, overall score). This is the
  substrate for the future batch-eval / trends / graphs phase.
- `~/.agent-evals/cache/` — cached judge responses keyed by
  (model, prompt, schema), so re-running the same session with the same
  model is free. Disable per run with `--no-cache`.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # compile to dist/
pnpm dev         # run src/cli/index.ts with tsx
```

## Architecture

- `src/model/session.ts` — normalized `Session` / `Turn` / `ToolCall` types,
  deterministic derived stats (`computeSessionStats`), and long-session
  utilities (payload truncation, compact turn-numbered rendering, windowing).
- `src/adapters/cursor.ts` — `SessionSource` implementation for Cursor: lists
  sessions from `~/.cursor/projects/*/agent-transcripts` joined with
  titles/recency from Cursor's `conversation-search.db` (read-only, with
  graceful fallbacks), and parses transcripts into the session model.
- `src/judge/` — LLM judge on `@earendil-works/pi-ai`: auto/explicit model
  selection, JSON-constrained responses with validation and one retry, disk
  cache, bounded concurrency.
- `src/metrics/` — the metric library; each metric combines an optional
  deterministic pre-pass with judge calls and returns
  `{ score, findings, advice }`.
- `src/cli/` — the `agent-evals` binary: `.env` loading, arg parsing,
  interactive picker (`@clack/prompts`), progress, report rendering.
- `src/store/runs.ts` — versioned run persistence to `~/.agent-evals/runs`.
