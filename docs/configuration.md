# Configuration

This file covers the LLM providers, embedding dimensions, and every environment variable.

This file covers the LLM provider switch, embedding dimensions, and every environment variable. All configuration lives in a `.env` file at the repo root. Bun loads it automatically. `.env.example` lists every variable with comments.

Only `MEMORY_DATABASE_URL` is required. Every other variable has a working default.

## LLM providers

ira-memory uses an LLM for two jobs: **embeddings** (semantic recall) and **summaries** (session summaries and fact extraction). Both go through one provider switch in `src/llm.ts`. Set `IRA_LLM_PROVIDER` in `.env` to choose it.

| Provider | Embeddings and summaries | Set | Data leaves the machine? |
|----------|--------------------------|-----|--------------------------|
| `openai` (default) | OpenAI cloud | `OPENAI_API_KEY` | Yes, to OpenAI |
| `gemini` | Google Gemini through its OpenAI-compatible endpoint. Flash for summaries, Gemini for embeddings. | `GEMINI_API_KEY` | Yes, to Google |
| `local` | Any OpenAI-compatible local server, such as Ollama or LM Studio | `OPENAI_BASE_URL` (default `http://localhost:11434/v1`) | No |
| `none` | Nothing. Embeddings and summaries are skipped. | none | No |

Default models per provider:

| Provider | Embedding model | Chat model |
|----------|-----------------|------------|
| `openai` | `text-embedding-3-small` | `gpt-4.1-nano` |
| `gemini` | `gemini-embedding-001` | `gemini-2.5-flash` |
| `local` | `nomic-embed-text` | `llama3.2` |

Override either with `IRA_EMBED_MODEL` or `IRA_LLM_MODEL`.

### Running without OpenAI

Recall still works when embeddings are off. With `none`, or with `IRA_EMBED=off`, recall skips the semantic layer and uses full-text search, structured filters, and project tags. Conversation logging, manual facts, and project-scoped recall all keep working.

Common setups:

- **Completely local, nothing leaves the machine:** set `IRA_LLM_PROVIDER=none`. This needs no extra infrastructure. Or set `IRA_LLM_PROVIDER=local` with Ollama for full semantic recall. This needs a local model server.
- **Use a Gemini key instead of an OpenAI bill:** set `IRA_LLM_PROVIDER=gemini` and `GEMINI_API_KEY`. You get Flash summaries and Gemini embeddings. Add `IRA_EMBED=off` if you want summaries with full-text recall only.

### Embedding dimensions

The pgvector schema is `vector(1536)`. This is fixed by the migrations.

- OpenAI `text-embedding-3-small` and Gemini `gemini-embedding-001` both emit 1536 dimensions. The client requests this size explicitly, so neither needs a schema change.
- A smaller fixed-size model, such as Ollama `nomic-embed-text` (768 dimensions), is zero-padded to 1536 before it is stored. Recall still works with it. Padding does not change the vector's direction, so cosine similarity stays meaningful.
- A larger model needs `IRA_EMBED_DIMS` plus a migration of the `*_embeddings` columns. That migration is only clean on a fresh database.

`IRA_EMBED_DIMS` defaults to `1536`. Change it only on a fresh database.

## Environment variables

Variables are grouped the same way as in `.env.example`.

### Database

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_DATABASE_URL` | PostgreSQL connection string. **Required.** | `postgresql://ira_memory:<password>@localhost:5433/ira_memory` |
| `IRA_DB_PORT` | Host port that docker-compose publishes. Bound to loopback only. | `5433` |
| `IRA_DB_PASSWORD` | Password for the compose container (`POSTGRES_PASSWORD`). Keep it in sync with the URL above. | `ira_memory_secret` in `docker-compose.yml` |
| `IRA_TEST_DATABASE_URL` | Throwaway, migrated database. Enables the DB tests in `bun test`. See [development.md](development.md#running-the-tests). | unset |
| `SMOKE_DATABASE_URL` | Throwaway, migrated database for `bun scripts/smoke.ts`. See [development.md](development.md#running-the-tests). | unset |

### LLM provider

| Variable | Description | Default |
|----------|-------------|---------|
| `IRA_LLM_PROVIDER` | `openai`, `gemini`, `local`, or `none`. See above. | `openai` |
| `OPENAI_API_KEY` | Required when `provider=openai` | unset |
| `GEMINI_API_KEY` | Required when `provider=gemini` | unset |
| `OPENAI_BASE_URL` | Custom endpoint for `local` or `gemini` | `http://localhost:11434/v1` for `local` |
| `IRA_LLM_BASE_URL` | Same as `OPENAI_BASE_URL`, read only when `provider=local` | `http://localhost:11434/v1` |
| `IRA_LLM_MODEL` | Chat model for summaries and learning | per provider (see above) |
| `IRA_EMBED` | Set to `off` to turn embeddings off but keep summaries | on |
| `IRA_EMBED_MODEL` | Embedding model | per provider (see above) |
| `IRA_EMBED_DIMS` | Must match the `vector(1536)` schema. Change only on a fresh database. | `1536` |
| `IRA_CHUNK_CHARS` | Embedding chunk size, in characters | `6000` |
| `IRA_CHUNK_OVERLAP` | Overlap between embedding chunks, in characters | `400` |
| `IRA_AUTO_LEARN` | Set to `false` to stop learning extraction on `store` | on |
| `IRA_DECISIONS_CONVO_CAP` | Characters of conversation sent to the decisions extraction pass. Larger than the summary cap on purpose, because locked decisions often appear late in a long session. | `60000` |

### HTTP API

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_API_HOST` | Bind address. Any non-loopback value requires `IRA_API_TOKEN`, or the server refuses to start. | `127.0.0.1` |
| `MEMORY_API_PORT` | Bind port | `7775` |
| `IRA_API_TOKEN` | When set, every route except `/health` requires `Authorization: Bearer <token>`. | unset |
| `IRA_CORS_ORIGINS` | Comma-separated browser origins allowed to call the API. Empty means no browser origin is allowed. | empty |
| `IRA_URL` | Where the MCP server, the hooks, and the pi extension find the API | `http://127.0.0.1:7775` |
| `IRA_CLIENT_TIMEOUT_MS` | Timeout for agent and hook calls to the API, in milliseconds | `2000` |

See [privacy.md](privacy.md#network-exposure) for what these defaults protect against.

### Storage paths

| Variable | Description | Default |
|----------|-------------|---------|
| `IRA_DATA_DIR` | Directory for local state: the sidecar database and hook state | `~/.ira-memory` |
| `IRA_SIDECAR_DB` | Explicit path to the sidecar SQLite file. Overrides `IRA_DATA_DIR`. | `~/.ira-memory/sidecar.db` |
| `IRA_BACKUP_DIR` | Directory where `backup` writes dumps and `restore` reads them | `<repo>/backups` |
| `IRA_DB_CONTAINER` | Running container that `backup` and `restore` `docker exec` into. Unset means this repo's compose service is used. | unset |

The sidecar file is `~/.ira-memory/sidecar.db`. Older installs used `~/.claude/memory-api-sidecar.db`. The server keeps using that legacy file when it exists, so existing entities and key-value data stay where they are.

### pi session capture

| Variable | Description | Default |
|----------|-------------|---------|
| `IRA_PI_SESSIONS_DIR` | Directory the server accepts pi session files from. Overrides the pi variables below. | unset |
| `PI_CODING_AGENT_SESSION_DIR` | pi's own override for its sessions directory. Used when `IRA_PI_SESSIONS_DIR` is unset. | unset |
| `PI_CODING_AGENT_DIR` | pi's own agent directory. The sessions directory is `<this>/sessions`. | `~/.pi/agent` |
| `IRA_PI_MESSAGE_CAP` | Maximum characters stored per user or assistant message | `50000` |
| `IRA_PI_TOOLRESULT_CAP` | Maximum characters stored per tool call argument list or tool result | `2000` |

See [capture.md](capture.md#pi-session-capture) for how these caps are used.

### Recall tuning

These defaults are measured, not guessed. Change them with care. See [how-it-works.md](how-it-works.md#retrieval-strategy).

| Variable | Description | Default |
|----------|-------------|---------|
| `IRA_SEMANTIC_RECALL` | Set to `0` for full-text only recall | `1` |
| `IRA_FTS_CEILING` | Maximum score a full-text match can contribute | `0.55` |
| `IRA_W_RELEVANCE` | Ranking weight for relevance | `0.6` |
| `IRA_W_RECENCY` | Ranking weight for recency | `0.15` |
| `IRA_W_TIER` | Ranking weight for tier | `0.15` |
| `IRA_W_CONFIDENCE` | Ranking weight for confidence | `0.1` |

### Tooling and scripts

| Variable | Description | Default |
|----------|-------------|---------|
| `IRA_BUN_PATH` | Absolute path to the `bun` binary. Set it when bun is not at `~/.bun/bin/bun`, for example under nvm, asdf, pnpm, or nix. Used by `install-hooks` and `scripts/cron-maintain.sh`. | `~/.bun/bin/bun`, or `command -v bun` |
| `IRA_PROJECT_DIR` | Overrides the project root for `scripts/cron-maintain.sh` | the script's parent directory |
| `IRA_LOG_DIR` | Overrides the log directory for `scripts/cron-maintain.sh` | `<repo>/logs` |
| `IRA_CWD` | Working directory the MCP server uses for project scoping | the process's working directory |
| `IRA_HOOK_DEBUG` | Set to any value to print hook errors to stderr. Hooks otherwise fail silently. | unset |

## Related

- [how-it-works.md](how-it-works.md): what the LLM and embedding settings affect.
- [privacy.md](privacy.md): what leaves the machine for each provider.
