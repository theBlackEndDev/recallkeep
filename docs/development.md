# Development

This file covers the repo layout, programmatic API, tests, CI, and the pre-push secret scan.

This file covers the repo layout, the programmatic API, how to run the tests, CI, and the pre-push secret-scan hook. For setup from scratch, see the Quick Start in the [README](../README.md).

## Infrastructure

The database is a Docker container defined in `docker-compose.yml`.

- **Image:** `pgvector/pgvector:pg16` (PostgreSQL 16 with the pgvector extension).
- **Port:** published on loopback only, on `RECALLKEEP_DB_PORT` (default `5433`, mapped from the container's `5432`). See [privacy.md](privacy.md#postgres).
- **Extensions:** `vector` (pgvector) and `pg_trgm` (trigram fuzzy search).
- **Indexes:** HNSW on the vector columns, for cosine search. HNSW was chosen over IVFFlat because IVFFlat needs data present when it is built, and its recall drops as the table grows. GIN on the tsvector columns for full-text search. GIN with trigram operators on the content columns.

## Repository layout

```
recallkeep/
├── prisma/
│   ├── schema.prisma                  Data model
│   └── migrations/                    Prisma and custom SQL migrations
├── src/                               Core library, CLI, HTTP API, MCP server, hooks
│   ├── index.ts                       Public API barrel export
│   ├── types.ts                       TypeScript types
│   ├── client.ts                      Prisma client
│   ├── store.ts                       Write operations (sessions, messages, facts)
│   ├── recall.ts                      Multi-layer recall and ranking
│   ├── search.ts                      Semantic vector search (pgvector)
│   ├── embed.ts                       Embedding generation, chunking, and backfill
│   ├── llm.ts                         Provider switch (openai, gemini, local, none)
│   ├── summarize.ts                   Summaries; derives project slugs
│   ├── slug.ts                        deriveProjectSlug (no dependencies)
│   ├── maintain.ts                    Tier promotion, expiration, conflicts, compaction
│   ├── export.ts                      JSON and markdown export, backup, restore, sensitive detection
│   ├── import.ts                      File-based memory importer (MEMORY.md, daily notes)
│   ├── decisions.ts                   Locked-decision extraction
│   ├── learn.ts                       Session ratings and lesson extraction
│   ├── discover.ts                    Cross-session pattern mining
│   ├── synthesize.ts                  Fact consolidation
│   ├── redact.ts                      Redaction chain: betterleaks, gitleaks, heuristic
│   ├── redact-rescan.ts               Re-run redaction on stored messages
│   ├── pi-capture.ts                  pi transcript importer
│   ├── cc-capture.ts                  Claude Code SessionEnd hook (write-only fast path)
│   ├── agent-memory.ts                Agent-facing operations shared by MCP and hooks
│   ├── hook.ts                        Lifecycle hooks for claude, codex, agy
│   ├── hook-bridge.ts                 Subcommand router for Claude Code hooks
│   ├── mcp.ts                         MCP server over stdio
│   ├── http-server.ts                 HTTP Memory API (Postgres plus sqlite sidecar)
│   ├── cli.ts                         CLI
│   ├── backfill-project-tags.ts       Tag historical facts with project:<slug>
│   ├── test-e2e.ts                    End-to-end script (not run by bun test)
│   ├── test-flow.ts                   Integration smoke script (not run by bun test)
│   └── *.test.ts                      Unit and database tests run by bun test
├── integrations/
│   ├── AGENTS.md                      Snippet for AGENTS.md, CLAUDE.md, or GEMINI.md
│   ├── pi/                            pi extension (README.md, API.md, tests)
│   ├── claude-code/settings.json      Example Claude Code hook config
│   ├── codex/config.toml              Example Codex CLI config (MCP and hooks)
│   └── antigravity/hooks.json         Example Antigravity CLI hook config
├── scripts/
│   ├── smoke.ts                       Contract smoke test
│   ├── eval-recall.ts                 Recall ranking evaluation
│   ├── sweep-weights.sh               Sweep ranking weights against the evaluation
│   ├── cron-maintain.sh               Hourly maintain, summarize-pending, and embedding backfill
│   ├── update.ts                      Update an installed copy
│   ├── start.sh                       Start Postgres, migrate, and run the API (used by deploy/)
│   ├── pre-push-hook.sh               Pre-push secret scan
│   ├── install-pre-push-hook.sh       Install the pre-push hook into repos
│   └── test-pre-push-hook.sh          Tests for the pre-push hook
├── deploy/
│   ├── systemd/recallkeep.service     Example systemd unit
│   └── launchd/dev.recallkeep.plist   Example launchd job
├── .github/workflows/ci.yml           CI pipeline
├── docker-compose.yml                 Postgres 16 with pgvector
├── .env.example                       Every configuration variable, documented
└── package.json
```

Directories such as `backups/` and `logs/` are created at runtime and are listed in `.gitignore`.

## Programmatic API

The public API is exported from `src/index.ts`. Import it from there:

```typescript
import {
  openSession, closeSession, storeMessage, store,
  recall, textSearch, semanticSearch,
  summarize, promoteAndExpire, detectConflicts,
  exportAll, exportMarkdown, backup, restore,
  importFromFiles, prisma,
} from "./src/index.js";

// Open a session
const session = await openSession({ channel: "cli", title: "My Session" });

// Store messages
await storeMessage({ sessionId: session.id, role: "user", content: "Hello" });
await storeMessage({ sessionId: session.id, role: "assistant", content: "Hi there" });

// Store a fact (auto-embeds, auto-detects sensitive content)
await store({
  category: "DECISION",
  content: "We chose PostgreSQL over SQLite for the memory system",
  tier: "LONG_TERM",
  source: "explicit",
  tags: ["infrastructure"],
});

// Recall with multi-layer search (structured + full-text + semantic)
const results = await recall({
  query: "database choice",
  categories: ["DECISION"],
  limit: 10,
});

// Semantic search only
const similar = await semanticSearch({
  query: "what database are we using",
  tables: ["facts", "summaries"],
  threshold: 0.4,
});

// Close the session (generates a summary via the LLM when a provider is set)
const { summary } = await closeSession(session.id);
```

When `RECALLKEEP_LLM_PROVIDER=none`, `store` still saves the fact. It just skips embedding and learning, and `closeSession` returns no summary.

## Running the tests

There are three kinds of check.

### Unit tests: `bun test`

```bash
bun test
```

`bun test` runs every `*.test.ts` file in `src/` and `integrations/pi/`. Pure tests run with no setup. Database tests are skipped unless `RECALLKEEP_TEST_DATABASE_URL` is set. Set it to a throwaway database that has been migrated:

```bash
export RECALLKEEP_TEST_DATABASE_URL=postgresql://recallkeep:<password>@localhost:5433/recallkeep_test
bunx prisma migrate deploy   # with RECALLKEEP_DATABASE_URL pointing at that database
bun test
```

Use a separate database. The tests write rows, so never point `RECALLKEEP_TEST_DATABASE_URL` at the database you use for real memory.

The test files use a plain assertion-counter pattern, not `bun:test`'s `test()` and `expect()`. So `bun test` reports `0 pass, 0 fail`, and each file prints its own count. Each file must still call `await main()` at the top level. If it does not, `bun test` drops the output silently.

### Contract smoke test: `bun scripts/smoke.ts`

```bash
SMOKE_DATABASE_URL=postgresql://recallkeep:<password>@localhost:5433/recallkeep_test bun scripts/smoke.ts > after.txt
```

The smoke test starts an isolated HTTP server on port `7799` and a temporary `HOME`. It sets the provider to `none`. It then records the status code and JSON shape of every endpoint, plus the exit code of each CLI command. Run it before and after a change and compare the two outputs with `diff`.

It refuses to run against any database whose name is `recallkeep` (the main database). The database must already be migrated.

### End-to-end script: `bun run src/test-e2e.ts`

`src/test-e2e.ts` covers CRUD, embeddings, semantic search, summarization, tier management, sensitive detection, export, and compaction. It is a script with about 29 assertion calls, not a `bun:test` suite. It needs a running database and an LLM provider, so it is not picked up by `bun test`. `src/test-flow.ts` is a shorter integration script. Run both by hand when you change the summarization or embedding paths.

## Recall evaluation

The recall ranking weights are checked against a labelled corpus, not by eye.

```bash
bun run scripts/eval-recall.ts --base http://127.0.0.1:7776
```

`eval-recall.ts` seeds synthetic facts named `__eval_*`, runs queries, and reports precision at 1 and 3, and mean reciprocal rank. It deletes its facts in a `finally` block.

Point it at a throwaway instance on port `7776`, never at the live service on `7775`. A crash mid-run would otherwise leave synthetic rows in the real store.

`scripts/sweep-weights.sh` starts a temporary server for each weight set, runs the evaluation, and stops the server. It asserts that no `__eval_*` rows remain. Note that the temporary server shares the same Postgres, so the synthetic rows do land in that database while the run is in progress.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. It starts a `pgvector/pgvector:pg16` service and runs:

1. `bun install --frozen-lockfile`
2. `bunx prisma generate` and `bunx prisma migrate deploy`
3. `bun run typecheck`
4. `bun test` (database tests run, because `RECALLKEEP_TEST_DATABASE_URL` is set)
5. `bun scripts/smoke.ts`

CI sets `RECALLKEEP_LLM_PROVIDER=none`, so no external calls are made.

## Pre-push secret scan

`scripts/pre-push-hook.sh` scans the commits being pushed for secrets. It uses two layers. gitleaks runs first. A narrow regular expression then covers token shapes that gitleaks's default rules do not recognize. The narrow pattern is kept deliberately small, because a false positive blocks a push outright.

The hook fails closed. If it cannot determine the range being pushed, if a scanner errors, or if gitleaks is missing, the push is blocked. To skip the hook for a known false positive, use `git push --no-verify`.

Install it into this repo and into any other repo you want covered:

```bash
./scripts/install-pre-push-hook.sh                   # this repo
./scripts/install-pre-push-hook.sh /path/to/repo     # another repo
```

With no arguments, the installer covers this repo and `~/.pi/agent/extensions`. The installer copies the script into `.git/hooks/pre-push`. Re-run it after you change the hook script, because it copies the file rather than linking to it.

Test the hook with `sh scripts/test-pre-push-hook.sh`. It runs the hook against throwaway repos.

## Related

- [configuration.md](configuration.md): the variables the tests and scripts read.
- [privacy.md](privacy.md): the redaction chain that the hook and the tests exercise.
