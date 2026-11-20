# How it works

This file explains the architecture, data flow, ranking, project scoping, decisions, learning, and tiers.

This file explains how RecallKeep is built: the storage layers, the data flow, how recall ranks results, how projects are scoped, the decisions layer, and how facts move between tiers.

## Architecture

```
Assistant (pi, Claude Code, Codex, Antigravity, CLI, or any HTTP client)
        |
   ┌────┴─────────────────────────────┐
   │                                  │
   HTTP Memory API (127.0.0.1:7775)   Programmatic API
   /memory/* /conversation/*          store() / recall() / search() / summarize()
   /entity/* /kv/* /session/sync      │
   │                                  │
   └────┬─────────────────────────────┘
        |
  PostgreSQL 16 + pgvector + pg_trgm        +  bun:sqlite sidecar
   ├── sessions          append-only            ├── entities  (lightweight people and projects)
   ├── messages          append-only            └── kv        (cron state, flags)
   ├── memory_facts      curated knowledge
   ├── summaries         compacted views
   ├── *_embeddings      1536-dim vectors
   └── file_sync_records file-import tracking
```

Postgres holds everything that needs search: sessions, messages, facts, summaries, and embeddings. A separate SQLite file holds entities and key-value data. Keeping them apart means the Postgres schema only has to describe memory.

## Data flow

```
1. User sends a message
   ├── storeMessage() writes to the database
   └── embedMessageAsync() queues an embedding (does not block)

2. Assistant responds
   ├── storeMessage() writes to the database
   └── Facts are detected and stored with store(), which auto-embeds and auto-detects sensitive content

3. Session ends
   ├── closeSession() sets endedAt
   └── summarize(SESSION) writes an LLM summary and extracts facts

4. Periodic maintenance (the cron script runs this hourly)
   ├── summarize(DAILY) rolls up session summaries
   ├── summarize(WEEKLY) rolls up daily summaries
   └── promoteAndExpire() moves facts between tiers
```

For pi and Claude Code, step 1 and step 2 happen through capture rather than explicit calls. See [capture.md](capture.md).

## Retrieval strategy

Recall runs four layers and merges the results by score.

| Layer | Method | Used when |
|-------|--------|-----------|
| 1. Exact lookup | SQL by ID | You have a session or fact ID |
| 2. Structured filter | SQL `WHERE` | Category, tier, time range, or tags |
| 3. Full-text search | tsvector and tsquery | Keyword queries |
| 4. Semantic search | pgvector cosine similarity | Free-form natural language |

Semantic search is skipped when embeddings are off. Full-text search and the structured layers still run.

### Scoring

Each fact gets one score:

```
score = W_RELEVANCE * relevance
      + W_RECENCY   * recency
      + W_TIER      * tier_weight
      + W_CONFIDENCE * confidence
      + boost
```

The defaults are `W_RELEVANCE = 0.6`, `W_RECENCY = 0.15`, `W_TIER = 0.15`, and `W_CONFIDENCE = 0.1`. Override them with the `RECALLKEEP_W_*` variables in [configuration.md](configuration.md#recall-tuning).

- **relevance** is the better of two signals. The full-text signal is capped at `RECALLKEEP_FTS_CEILING` (default `0.55`), because a keyword rank only means something relative to its own result set. The semantic signal is cosine similarity, which is absolute. A fact that does not match at all scores `0`, so relevance leads whenever anything matches.
- **recency** is `1 / (1 + 0.1 * days_old)`.
- **tier_weight** is `1.0` for `LONG_TERM`, `0.6` for `DAILY`, and `0.3` for `SHORT_TERM`.
- **confidence** is the fact's stored confidence, from `0` to `1`.
- **boost** is `0.5` when a fact carries one of the caller's `boostTags`, and `0` otherwise. See the project scoping section.

The weights were chosen by a sweep against a labelled test corpus. The sweep is `scripts/eval-recall.ts`, run by `scripts/sweep-weights.sh`. See [development.md](development.md#recall-evaluation).

Message recall uses a different formula with the same ingredients: `0.25 * recency + 0.75 * relevance`.

## Project-scoped recall

Recall is biased toward the project a session is working in, so a large project's memory does not drown out the one you are in.

### Slug derivation

`deriveProjectSlug` in `src/slug.ts` is the one shared rule. It returns the directory directly under a `projects` directory. It recognizes two layouts:

- `/<root>/projects/<slug>/...` (server layout)
- `~/Projects/<slug>/...` (home layout, for example on macOS)

Nested repositories resolve to the outer directory. A working directory that is exactly a projects root (such as `~/Projects`) resolves to the slug `Projects`. This is a deliberate catch-all for sessions that are not inside any project. Any other path falls back to its last path segment.

The pi extension has its own copy of this rule in `integrations/pi/slug.ts`. A parity test in each repo checks that the two agree.

### Write time

Facts produced by session summarization are tagged `project:<slug>`, derived from the session's `cwd`. Their content is prefixed with `[<slug>]` so full-text and semantic queries also match the slug.

### Recall time

There are two modes, and they are deliberately different.

| Caller passes | Mode | Behavior |
|---------------|------|----------|
| `?project=` or `X-Project` | Hard filter (`tags`) | Only that project's facts are returned, or nothing. Use it when you want one project and nothing else. |
| `X-Cwd` | Soft boost (`boostTags`) | Facts from the same project get a `+0.5` score boost and rank first, but other projects still appear. A new or sparse project never returns an empty result. |

When no project information is sent, recall is global. This keeps older callers working.

## Decisions

`src/decisions.ts` runs at session close. It is separate from `learn()`, which records mistakes and best practices. This pass records **locked decisions** only.

- It looks for explicit lock language, such as "locked", "decided", or "let's go with X". Open questions and rejected options are filtered out.
- Each decision is stored as category `DECISION` with tier `LONG_TERM`. A locked decision should not decay through the 48-hour promotion path that a passing preference takes.
- Tags are `decision` and `project:<slug>`.
- Duplicates are checked against existing decisions by semantic similarity, so restating a decision in a later session does not create a second row.

The pi extension injects the current project's decisions into the system prompt at session start, under the heading `## Locked decisions for this project`, with a budget of about 2000 characters. This lets a new session see what is already settled, so it does not reopen decided questions. See [capture.md](capture.md#decisions) for the pi side.

## Summaries

- `summarize(SESSION)` writes a summary when a session closes. It can also extract facts from the transcript.
- `summarize(DAILY)` and `summarize(WEEKLY)` roll up the lower level.
- `summarize(PROJECT)` writes a project-level summary.
- Summaries are retrieved alongside facts in `/memory/recall`.

Facts marked sensitive are excluded from summaries. See [privacy.md](privacy.md).

## Learning

Session close can also run `learn()`, which records a rating and extracts lessons. Lessons fall into five types: `MISTAKE`, `BEST_PRACTICE`, `INSTITUTIONAL`, `WORKFLOW_PREF`, and `CODEBASE_RULE`.

- `discover()` mines repeated patterns across sessions and writes them as `PREFERENCE` or `LESSON` facts.
- `synthesize()` rolls related facts into one consolidated answer, and can save it.
- Automatic learning on `store` can be turned off with `RECALLKEEP_AUTO_LEARN=false`.

## Tiers

Every fact has a tier. Tiers control how long a fact lasts.

| Tier | Meaning |
|------|---------|
| `SHORT_TERM` | Expires after 48 hours unless promoted. This is the default for new facts. |
| `DAILY` | Kept in a rolling window of about a week. |
| `LONG_TERM` | Kept until archived. Never deleted automatically. |

`maintain` runs the lifecycle:

```
SHORT_TERM ──(48h, confidence >= 0.7)──> DAILY ──(7 days)──> LONG_TERM
SHORT_TERM ──(48h, confidence < 0.7)──> archived
```

Facts stored through the HTTP `/memory` route are `LONG_TERM` from the start. Facts stored through `store()` with no tier given start as `SHORT_TERM`. Decisions are stored as `LONG_TERM` directly.

Archiving is a soft delete. An archived fact is hidden from recall but kept in the database. `delete` removes the row permanently.

## Related

- [capture.md](capture.md): how facts and messages get into the store.
- [how-it-works.md#retrieval-strategy](#retrieval-strategy): ranking detail above.
- [privacy.md](privacy.md): what is stored, what is redacted, and what leaves the machine.
