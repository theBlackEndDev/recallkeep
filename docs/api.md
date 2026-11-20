# HTTP Memory API

This file lists every endpoint of the HTTP Memory API, its auth headers, and how to start it.

This file lists every endpoint of the HTTP Memory API, the auth headers it reads, and how to start it. The API is served by `src/http-server.ts`. The pi extension's view of the same API is in [integrations/pi/API.md](../integrations/pi/API.md).

## Starting the server

```bash
bun run memory-api
# → [memory-api] listening on http://127.0.0.1:7775
```

The server binds to `RECALLKEEP_API_HOST` (default `127.0.0.1`) on `RECALLKEEP_API_PORT` (default `7775`). The server refuses to start on any non-loopback host unless `RECALLKEEP_API_TOKEN` is set. See [privacy.md](privacy.md) for the full exposure rules.

## Authentication and headers

| Header | Used by | Effect |
|--------|---------|--------|
| `Authorization: Bearer <token>` | every route except `/health` | Required when `RECALLKEEP_API_TOKEN` is set. Otherwise the route returns `401`. |
| `X-Project: <slug>` | recall and list routes | Hard filter. Results are limited to that project. |
| `X-Cwd: <path>` | recall routes | The project slug is derived from the path. It gives a soft boost, not a filter, so other projects still appear. |
| `Origin` | every route | Requests with an `Origin` not listed in `RECALLKEEP_CORS_ORIGINS` get `403`. Requests without an `Origin` (agents, hooks, curl) pass. |

Project scoping works in two modes. `?project=` or `X-Project` filters strictly. `X-Cwd` boosts. Use `X-Cwd` for ambient, per-prompt recall, and use `?project=` when you want only one project's facts.

Errors return JSON in the form `{"error": "..."}`. A missing required parameter returns `400`. An unknown route returns `404`.

## Endpoints

### Health

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness check. Returns `{status, backend, port}`. Does not need a token. |

### Conversation (raw messages)

| Method | Path | Parameters and body | Purpose |
|--------|------|---------------------|---------|
| POST | `/conversation/log` | Body: `role` (required), `content` (required), `channel`, `cwd`, `metadata` | Append one message. The server creates or reuses a long-lived session per channel. Returns `{id, session_id}`. |
| GET | `/conversation/recent` | `?limit=` (default 20, max 200), `?channel=`, `?project=` | Newest messages, optionally filtered by channel or project. |
| GET | `/conversation/search` | `?q=` (required), `?limit=` (max 200) | Full-text search over messages only. |
| GET | `/conversation/recall` | `?q=` (required), `?project=`, `?channel=`, `?limit=` (max 100) | Hybrid full-text and vector search over messages, scoped by project or channel. This is the route the pi `memory_search` tool calls. |
| GET | `/conversation/message/<id>` | Path: message id | Fetch one message in full. Use it to expand a truncated search result. |

### Session capture

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/session/sync` | `{sessionFile, sessionId?, cwd?, final?}` | Import or re-import a pi session transcript. Send a file path only, never content. The server reads the file itself. Returns `202` immediately and imports in the background. The path must be under pi's sessions directory, or the server returns `403`. |

See [capture.md](capture.md#pi-session-capture) for how the import works.

### Memory facts

| Method | Path | Parameters and body | Purpose |
|--------|------|---------------------|---------|
| POST | `/memory` | Body: `content` (required), `type` (`user`, `feedback`, `project`, `reference`; default `user`), `name`, `description`, `project`, `tags` | Store a fact. The fact is stored with tier `LONG_TERM`. The `type` maps to a category (see below). Returns the stored fact. |
| GET | `/memory/list` | `?limit=` (default 50, max 500) | List facts. Scoped by `X-Project` or `X-Cwd` when set. Returns `{facts, total}`. |
| GET | `/memory/recall` | `?topic=`, `?project=`, `?limit=` (max 100) | Multi-layer recall (structured filter, full-text, and semantic). Returns `{facts, summaries}`. Uses `X-Cwd` for a boost. |
| GET | `/memory/search` | `?q=` (required), `?limit=` (max 100) | Full-text search over facts. |
| DELETE | `/memory/<id>` | Path: fact id | Soft-archive a fact. The row is kept, but recall stops returning it. Returns `{id, archived: true}`. |

The `type` field on `POST /memory` maps to a category at the API boundary:

| `type` | Category |
|--------|----------|
| `user` | `PREFERENCE` |
| `feedback` | `LESSON` |
| `project` | `PROJECT_STATE` |
| `reference` | `CONTEXT` |

When a project is set, the server prefixes the stored content with `[<slug>]` and adds the tag `project:<slug>`. This keeps the slug searchable.

### Entities (sidecar)

Entities are stored in a `bun:sqlite` sidecar file, not in Postgres. See [configuration.md](configuration.md#storage-paths) for where the file lives.

| Method | Path | Parameters and body | Purpose |
|--------|------|---------------------|---------|
| POST | `/entity` | Body: `name`, `type` (both required), `details` (optional object) | Create an entity. Returns `{id, name, type}`. |
| GET | `/entity/search` | `?q=` | Find entities whose `name` or `type` contains `q`. Returns up to 100 rows. |

### Key-value (sidecar)

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| GET | `/kv/<key>` | none | Read a value. Returns `404` if the key does not exist. |
| PUT | `/kv/<key>` | `{"value": ...}` (or the raw JSON value) | Write a value. Creates or overwrites. |
| DELETE | `/kv/<key>` | none | Delete a key. |

Use the key-value store for small scratch state, such as cron progress or feature flags.

## Using the API from the CLI

The CLI and the HTTP API read the same data. For commands, see [cli.md](cli.md).

## Related

- [integrations/pi/API.md](../integrations/pi/API.md): the pi extension's client view of this API.
- [privacy.md](privacy.md): token, CORS, and bind-address rules.
- [configuration.md](configuration.md): the `MEMORY_API_*` and `RECALLKEEP_API_TOKEN` variables.
