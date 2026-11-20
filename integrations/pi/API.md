# RecallKeep HTTP API (used by memory extension)

Base URL: `http://127.0.0.1:7775` (overridable via `RECALLKEEP_API_PORT` / `RECALLKEEP_API_HOST` env vars on the server; http-server.ts).

Source: `../../src/http-server.ts`. All responses are JSON with permissive CORS headers (http-server.ts). Errors are `{"error": "<msg>"}` with status 400 (validation), 404 (unknown route), or 500 (exception) (http-server.ts, 254).

## Project resolution (shared by all endpoints)

`resolveProject(req, url)` (http-server.ts) checks, in order:
1. `?project=<slug>` query param
2. `X-Project: <slug>` header
3. `X-Cwd: <path>` header — converted via `deriveProjectSlug`; the path is expected to contain `/srv/projects/<slug>/...`

Returns `null` when none apply; callers (endpoints) then behave un-filtered.

---

## POST /memory

Store a typed memory fact (http-server.ts).

### Request
Headers: `Content-Type: application/json`; optional `X-Project`, `X-Cwd` (see project resolution above).

Body fields:
| Field | Type | Required | Notes |
|---|---|---|---|
| `content` | string | **Yes** | 400 if missing (http-server.ts) |
| `type` | string | No | Fact type; default `"user"` (http-server.ts). Lowercased, then mapped: `user→PREFERENCE`, `feedback→LESSON`, `project→PROJECT_STATE`, `reference→CONTEXT` (http-server.ts); unknown values fall back to `CONTEXT` (http-server.ts) |
| `name` | string | No | Stored in fact metadata |
| `description` | string | No | Stored in fact metadata |
| `project` | string | No | Explicit project slug; overrides header-derived project (http-server.ts) |
| `tags` | string[] | No | Appended to server-computed tags |

### Server-side defaults / overrides
- Stored fact is always `tier: "LONG_TERM"`, `source: "explicit"` (http-server.ts).
- Tags are **rebuilt** as `["friday:<lowercased type>", "project:<slug>" (if project), ...body.tags]` (http-server.ts, 186).
- If a project resolves (body, header, or cwd), the stored content is **rewritten** to `"[<slug>] <content>"` unless it already starts with `[<slug>]` (http-server.ts).
- Metadata is set to `{ name, description, friday_type, project? }` — client-supplied `metadata` in the body is **ignored** (http-server.ts).

### Response `200`
Shape per `serializeFact` (http-server.ts):
```json
{
  "id": "string",
  "name": "string | null",          // metadata.name
  "type": "string | null",          // metadata.friday_type ?? lowercased category
  "description": "string | null",   // metadata.description
  "content": "string",              // possibly "[slug]-prefixed"
  "category": "string",             // PREFERENCE | LESSON | PROJECT_STATE | CONTEXT
  "tier": "string",                 // always "LONG_TERM"
  "tags": "string[]",
  "created_at": "string",           // fact.createdAt
  "score": "number | undefined"
}
```

---

## POST /session/sync

The pi memory extension's primary write path — see `index.ts`'s docstring
header for why `POST /conversation/log` (below) is not used for pi sessions.

Imports (or re-imports) a pi session transcript from disk. Carries a file path,
never message content — the server reads `sessionFile` itself and extracts
user/assistant text, redacting anything secret-shaped before storing (`pi-capture.ts`,
`redact.ts`). Idempotent per transcript entry: safe to call repeatedly against the
same growing file, and only new entries get imported.

### Request
Headers: `Content-Type: application/json`.

Body fields:
| Field | Type | Required | Notes |
|---|---|---|---|
| `sessionFile` | string | **Yes** | Must resolve under `~/.pi/agent/sessions/` — 403 otherwise. This is a trust boundary: the server reads whatever path it's given. |
| `sessionId` | string | No | Hint only; the file's own `{"type":"session", id}` header is authoritative when present. |
| `cwd` | string | No | Hint only; the file's own header `cwd` is authoritative when present. Used for project-slug resolution. |
| `final` | boolean | No | `true` on `session_shutdown`: marks the imported RecallKeep session `endedAt`. Default `false`. |

### Response `202`
```json
{ "accepted": true }
```
Import runs asynchronously after the response is sent — the endpoint does not wait
for the file to be parsed and stored, so a large/slow session never risks tripping
the client's 800ms timeout. Import errors are logged server-side
(`console.error("[session/sync] failed for ...")`), not surfaced to the caller.

### Response `403`
```json
{ "error": "sessionFile must be under ~/.pi/agent/sessions/" }
```

---

## POST /conversation/log

Append a message to the (persistent) session for a channel (http-server.ts).
**No longer used by the pi memory extension** (superseded by `/session/sync` above);
still used by other callers of the raw HTTP API.

### Request
Headers: `Content-Type: application/json`.

Body fields:
| Field | Type | Required | Notes |
|---|---|---|---|
| `role` | string | **Yes** | 400 if missing (http-server.ts) |
| `content` | string | **Yes** | 400 if missing (http-server.ts) |
| `channel` | string | No | Defaults to `"unknown"` (http-server.ts) |
| `metadata` | object | No | Passed through to the stored message |

### Server-side defaults / overrides
- A session is resolved or created per `channel`: reuses the most recent open session for that channel, else creates one titled `"<channel> conversation"` with metadata `{ source: "memory-api-7775", persistent: true }` (http-server.ts). Sessions are cached in-process per channel.
- `role`/`content` are stored verbatim (no normalization).

### Response `200`
```json
{ "id": "string", "session_id": "string" }
```
(http-server.ts)

---

## GET /memory/list

List stored facts, newest-first per backend ordering (http-server.ts).

### Request
Query params:
| Param | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | No | Default `50`, capped at `500` (http-server.ts) |
| `project` | string | No | See project resolution; also accepted via `X-Project` / `X-Cwd` headers |

### Server-side defaults / overrides
- When a project resolves, results are filtered to facts tagged `project:<slug>` (http-server.ts). When no project resolves, **all** facts are returned (un-filtered back-compat behavior).

### Response `200`
```json
{
  "facts": [ { ...serializeFact shape as POST /memory... } ],
  "total": "number"
}
```
(http-server.ts, 106-117)

---

## GET /memory/recall

Hybrid recall over curated facts: structured tag/category/tier filters + OR-semantics
FTS + semantic (pgvector) search, combined by a weighted score (relevance 0.6, recency
0.15, tier 0.15, confidence 0.1, plus an optional project boost) — `src/recall.ts`.

**Param name is `topic`, not `q`.** A caller sending `?q=` gets it silently ignored:
`query` arrives undefined, the FTS and semantic layers never run, and the endpoint
degrades to topic-less recency ranking — same newest facts for every query. This
exact bug hid the recall path from every caller for a long time.

### Request
Query params:
| Param | Type | Required | Notes |
|---|---|---|---|
| `topic` | string | No | Without it: recency-ranked facts only (the resume path) |
| `limit` | number | No | Default 20, capped at 100 |
| `project` | string | No | **Hard tag filter** (`project:<slug>`), e.g. via `?project=` or `X-Project` |
| — | — | — | `X-Cwd` header instead **boosts** (never filters) the derived project |

### Response `200`
```json
{
  "facts":   [ { ...fact, "score": 0.82 } ],
  "summaries": [ { "id": "…", "scope": "…", "content": "…", "period_start": "…" } ]
}
```
Facts carry their ranking `score` (absolute, comparable across queries).

---

## GET /conversation/recent

Fetch recent messages across sessions (http-server.ts).

### Request
Query params:
| Param | Type | Required | Notes |
|---|---|---|---|
| `limit` | number | No | Default `20`, capped at `200` (http-server.ts) |
| `channel` | string | No | Filter to sessions of this channel |
| `project` | string | No | See project resolution; also accepted via `X-Project` / `X-Cwd` headers |

### Server-side defaults / overrides
- Project filtering matches sessions whose metadata `cwd` **contains** `/projects/<slug>` (http-server.ts) — this differs from the tag-based filtering of `/memory/list`.
- With no `channel` and no resolvable project, returns messages from **all** sessions (un-filtered).
- Messages ordered by `createdAt` descending; `limit` applied server-side.

### Response `200`
Shape per `serializeMessage` (http-server.ts):
```json
{
  "messages": [
    {
      "id": "string",
      "role": "string",
      "content": "string",
      "channel": "string | null",   // from the parent session
      "created_at": "string"
    }
  ]
}
```

---

## Errors

- `400 {"error": "..."}` — missing required fields (`content required` for POST /memory, `role and content required` for POST /conversation/log) (http-server.ts, 177).
- `404 {"error": "not found"}` — unmatched route (http-server.ts).
- `500 {"error": "<exception message>"}` — handler threw (http-server.ts).

Malformed JSON bodies are parsed as `null`, which then fails the required-field check → 400 (http-server.ts).
