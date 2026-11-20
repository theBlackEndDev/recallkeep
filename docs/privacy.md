# Privacy and security

This file explains what ira-memory stores, what it redacts, what it exposes, and how to clean up sensitive data.

This file explains what ira-memory stores, what it redacts before storing, what it refuses to expose, and how to check and clean up sensitive data. Read it before you expose the API beyond your own machine.

## The privacy model

ira-memory is single-user. Every channel (CLI, pi, Claude Code, Codex, Antigravity, and any HTTP client) shares one memory pool. There are no per-channel access rules.

- `session.channel` is metadata for filtering. It is not an access boundary.
- Anything that can reach the HTTP API can read and write all memory. Protect the API accordingly (see [Network exposure](#network-exposure)).
- Sensitive facts are flagged, not hidden. The user can still query them directly.

## What leaves the machine

Data is sent to an LLM provider only when you use one.

| Provider | What is sent | Leaves the machine? |
|----------|--------------|---------------------|
| `openai` | Text for embeddings and summaries | Yes, to OpenAI |
| `gemini` | Text for embeddings and summaries | Yes, to Google |
| `local` | Text for embeddings and summaries, to a local server | No |
| `none` | Nothing | No |

Redaction runs before the embeddings call, so a redacted secret is not sent to the provider either. See [configuration.md](configuration.md#llm-providers) for how to choose a provider.

## Redaction

Redaction removes secret values from text before it is stored. It runs on pi transcripts and on any turn logged by a hook. It does not run on facts you save explicitly.

### What is and isn't redacted

| Source | Redacted before storage? |
|--------|--------------------------|
| pi session transcripts (`/session/sync`) | Yes |
| Turns logged by the Claude Code, Codex, and Antigravity hooks | Yes |
| Claude Code transcripts (`capture` and the `SessionEnd` hook in `src/cc-capture.ts`) | **No**. This path does not call the redaction chain. |
| Facts saved explicitly with `store`, `POST /memory`, or `memory_save` | **No** |

Facts saved explicitly are stored as written. Do not save secrets with `memory_save`. The agent instructions in `integrations/AGENTS.md` say the same.

The Claude Code path does not redact at import time, unlike the pi path. To clean up after the fact, run `redact-rescan`. It reruns the chain over every stored message, including Claude Code rows, and updates any row whose content changes. Run `detect-sensitive` as well to flag facts that match the sensitive patterns.

### The engine chain

Redaction uses three engines, composed. Each one runs; a pure fallback chain would not catch everything.

1. **betterleaks** (`brew install betterleaks`). It uses byte-pair-encoding rarity and context filtering, so it does not flag prose that only mentions a `KEY=value` shape.
2. **gitleaks**, used only when betterleaks is not installed. It produces the same finding format.
3. **heuristic** (regular expressions in `src/redact.ts`). It needs no external tool and always runs, on top of whichever CLI engine ran.

The heuristic layer always runs because the two CLI engines are keyword- and context-gated. In testing, neither one caught a real Anthropic session key that sat in a tool result. The heuristic layer does catch it, because it matches the key prefix without requiring a nearby keyword.

The cost of this design is some false positives. A harmless line can get a `[REDACTED]` placeholder. That is recoverable, because the original transcript file on disk is never changed and a re-import restores the text. A real secret that survives redaction is not recoverable, so the design leans toward over-redaction.

`metadata.redactionEngine` on each stored row records which engine or engines redacted it: `betterleaks`, `gitleaks`, `heuristic`, `betterleaks+heuristic`, or `gitleaks+heuristic`.

Redaction runs in one batch per sync, so a long session does not start one process per message.

## Sensitive facts

Separately from redaction, each fact has an `isSensitive` flag. `src/export.ts` sets it when the content matches a pattern for:

- OpenAI, GitHub, GitHub OAuth, and Slack tokens, and AWS access keys
- `password`, `secret`, and long `token` assignments
- long base64-looking strings
- credit card numbers and US social security numbers

`store()` sets the flag automatically unless you pass `isSensitive` yourself. The flag has these effects:

- Sensitive facts are excluded from `exportMarkdown()`.
- Sensitive facts are excluded from LLM-generated summaries.
- Sensitive facts are still returned by direct queries.

## Detect sensitive and redact-rescan

### `detect-sensitive`

```bash
bun run src/cli.ts detect-sensitive
```

Scans every stored fact against the sensitive patterns and marks matches. It only sets the flag. It does not change or delete content.

### `redact-rescan`

```bash
bun run redact-rescan             # re-redact stored messages under the current engine chain
bun run redact-rescan -- --dry-run   # report what would change, change nothing
```

Redaction only runs at import time, so rows stored before an engine improved keep their old content. `redact-rescan` runs the current chain over every stored message. It updates a row only when its content changes. Use `--dry-run` first to see the count.

## Network exposure

The HTTP API has no login by default, so its bind address and token are the only protection. These are the defaults and the rules.

| Setting | Default | Effect |
|---------|---------|--------|
| `MEMORY_API_HOST` | `127.0.0.1` | Listens on loopback only. |
| `IRA_API_TOKEN` | unset | When set, every route except `/health` requires `Authorization: Bearer <token>`. Comparison is constant-time. |
| `MEMORY_API_HOST` set to a non-loopback address | refused | The server exits at startup unless `IRA_API_TOKEN` is set. |
| `IRA_CORS_ORIGINS` | empty | No browser origin may call the API. A web page you visit cannot read or write memory. |

Other protections:

- A request with a foreign `Origin` header gets `403`. This blocks cross-site requests from a browser.
- On loopback, a request whose `Host` header is not a loopback name gets `403`. This blocks DNS rebinding attacks.
- Agents and hooks send neither header, so they are not affected.

### Postgres

The database container publishes its port on loopback only: `127.0.0.1` and `[::1]`, on `IRA_DB_PORT` (default `5433`). The default password in `docker-compose.yml` is public. Never publish the database port to a LAN address. Set `IRA_DB_PASSWORD` to a strong value before the first `docker compose up`.

### Session file reads

`POST /session/sync` reads a file path that the client sends. The server accepts only paths under pi's sessions directory and returns `403` for anything else. See [capture.md](capture.md#which-files-the-server-will-read).

## Forgetting data

- `forget <id>` (CLI) or `DELETE /memory/<id>` (HTTP) soft-archives a fact. Recall stops returning it. The row is kept.
- `delete <id>` (CLI) permanently removes a fact and its embedding.
- `compact --days N` truncates old messages and drops their embeddings.

Backups keep old data. A dump taken before a delete still contains the deleted rows. Treat backup files as sensitive. The `.gitignore` excludes `backups/` and `*.dump`.

## Related

- [api.md](api.md): the routes and headers referenced above.
- [configuration.md](configuration.md): the variables that control exposure and providers.
- [capture.md](capture.md): where redaction runs in the capture paths.
