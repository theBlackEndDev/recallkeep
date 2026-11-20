# CLI reference

This file is the reference for every `recallkeep` CLI command.

This file lists every command of the `recallkeep` CLI. Run commands with:

```bash
bun run src/cli.ts <command> [options]
```

Run `bun run src/cli.ts` with no command to print the same usage text listed here.

## Core operations

| Command | Description | Example |
|---------|-------------|---------|
| `list` | List facts, with filters | `list --category TODO --tier DAILY --limit 10` |
| `store` | Store a fact | `store --category DECISION --content "Use pgvector for search" --tier LONG_TERM` |
| `forget` | Soft-archive a fact | `forget <id>` |
| `delete` | Permanently delete a fact | `delete <id>` |
| `sessions` | List sessions | `sessions --limit 5` |
| `stats` | Show counts and breakdowns | `stats` |

`list` also accepts `--archived` to include archived facts.

## Search and recall

| Command | Description | Example |
|---------|-------------|---------|
| `search` | Full-text search (PostgreSQL tsvector) | `search pgvector deployment` |
| `semantic` | Vector similarity search (pgvector) | `semantic "what tech stack do we use" --tables facts,messages` |
| `recall` | Multi-layer recall (structured, full-text, and semantic) | `recall --query "auth decisions" --categories DECISION --since 2026-03-01` |

See [how-it-works.md](how-it-works.md#retrieval-strategy) for how `recall` ranks results.

## Summarization

| Command | Description | Example |
|---------|-------------|---------|
| `summarize` | Generate a summary | `summarize --scope SESSION --session <id>` |
| `summarize` | Daily summary | `summarize --scope DAILY --date 2026-04-05` |
| `summarize` | Weekly summary | `summarize --scope WEEKLY --date 2026-03-31` |
| `summarize` | Project summary | `summarize --scope PROJECT --project my-app` |
| `summarize-pending` | Summarize closed sessions that do not have a summary yet. Takes `--limit N` and `--skip-learn`. | `summarize-pending --limit 20` |

## Maintenance

| Command | Description | Example |
|---------|-------------|---------|
| `maintain` | Run tier promotion and expiration. See [how-it-works.md](how-it-works.md#tiers). | `maintain` |
| `compact` | Truncate old messages and drop old embeddings. Default is 90 days. | `compact --days 90` |
| `conflicts` | Detect contradictory facts | `conflicts --limit 20` |
| `threads` | Show cross-session threading chains | `threads --limit 20` |
| `detect-sensitive` | Scan all facts and mark sensitive ones. See [privacy.md](privacy.md#detect-sensitive-and-redact-rescan). | `detect-sensitive` |

`redact-rescan` is not a CLI subcommand. It is a separate script, run with `bun run redact-rescan` (or `bun run redact-rescan -- --dry-run` to preview). See [privacy.md](privacy.md#detect-sensitive-and-redact-rescan).

## Import, export, and backup

| Command | Description | Example |
|---------|-------------|---------|
| `import` | Import from file-based memory (`MEMORY.md` and daily notes) | `import --memory-md /path/to/MEMORY.md --daily-dir /path/to/memory/` |
| `export` | Export as JSON or markdown | `export --format md` or `export --format json` |
| `backup` | Create a timestamped `pg_dump` | `backup` |
| `restore` | Restore from a `pg_dump` file | `restore ./backups/recallkeep-2026-04-06.sql` |
| `backfill` | Generate embeddings for items that do not have one | `backfill --type facts --batch 50` |

See [migration.md](migration.md) for how these commands fit into an upgrade or a move.

## Project tags

`src/backfill-project-tags.ts` is a separate script, not a CLI subcommand. It tags historical facts with `project:<slug>`. The run is idempotent and makes no LLM calls.

```bash
bun run src/backfill-project-tags.ts --dry-run                       # preview groups and counts
bun run src/backfill-project-tags.ts                                  # apply to all projects
bun run src/backfill-project-tags.ts --project my-app                 # scope to one project
```

The script runs two passes. The first tags facts whose session `cwd` resolves to a slug. The second tags facts whose content starts with `[<slug>]` but lacks the tag, for example facts posted by hand with no session. Only sessions that recorded a `cwd` can be tagged by the first pass. Everything captured from now on is tagged automatically.

## Learning loop

| Command | Description | Example |
|---------|-------------|---------|
| `learn` | Record a session rating and extract lessons. Takes `--session ID`, `--types`, and `--dedup`. | `learn --session <id> --types MISTAKE,BEST_PRACTICE --dedup` |
| `discover` | Mine repeated patterns from a source directory into facts. Takes `--aspects` and `--project`. | `discover ./src --project my-app` |
| `synthesize` | Roll up related facts into a consolidated answer. Use `--save` to store it and `--categories` to filter. | `synthesize "what do we know about auth" --save` |

Learning types are `MISTAKE`, `BEST_PRACTICE`, `INSTITUTIONAL`, `WORKFLOW_PREF`, and `CODEBASE_RULE`.

## Capture and integrations

| Command | Description | Example |
|---------|-------------|---------|
| `install-hooks` | Install the Claude Code `SessionEnd` capture hook. See [capture.md](capture.md#claude-code-session-capture). | `install-hooks` |
| `capture` | Import one Claude Code transcript by hand | `capture --transcript ~/.claude/sessions/<id>/transcript.jsonl` |
| `mcp` | Run the MCP server over stdio. The HTTP API must be running. | `mcp` |
| `hook` | Lifecycle hook for a coding agent. Reads event JSON on stdin. | `hook claude session-start` |

### The `hook` command

```bash
bun run src/cli.ts hook <claude|codex|agy> <session-start|prompt|stop>
```

| Event | What it does |
|-------|--------------|
| `session-start` | Injects standing rules, locked decisions, and recent facts. |
| `prompt` | Logs the user's prompt and injects facts related to it. |
| `stop` | Logs the assistant's final reply for the turn. |

The agent harness pipes its event JSON to stdin. Every failure is swallowed, so the hook exits `0` with no output when memory is down. This means an unreachable memory service never blocks an agent. Set `RECALLKEEP_HOOK_DEBUG=1` to print errors to stderr.

The `agy` harness has no prompt-submit event. It uses `PreInvocation` instead, which runs before every model call in a turn.

### The `mcp` command

`mcp` starts a stdio MCP server named `recallkeep`. It is a thin layer over the HTTP API, so `RECALLKEEP_URL` must point at a running server. The working directory for project scoping comes from `RECALLKEEP_CWD`, or from the process's working directory if `RECALLKEEP_CWD` is unset.

The server registers these tools: `memory_search`, `memory_save`, `memory_context`, `memory_list`, and `memory_forget`.

## Categories and tiers

**Categories:** `PREFERENCE`, `DECISION`, `PLAN`, `TODO`, `FACT`, `LESSON`, `CHECKPOINT`, `CONTEXT`, `TOOL_CONFIG`, `PROJECT_STATE`

**Tiers:** `SHORT_TERM`, `DAILY`, `LONG_TERM`. See [how-it-works.md](how-it-works.md#tiers) for what each tier means.

## Related

- [api.md](api.md): the same operations over HTTP.
- [configuration.md](configuration.md): environment variables used by these commands.
