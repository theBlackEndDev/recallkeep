# pi integration for ira-memory

A [pi](https://github.com/earendil-works/pi) extension that connects pi sessions to ira-memory.
It gives each session continuity across restarts and keeps a searchable copy of every
conversation.

## What it does

- **At session start** it shows, and injects into the system prompt: your standing rules
  (facts saved under project `global`), the project's locked decisions, recent facts, and the
  last session's handoff.
- **After each turn** it asks ira-memory to import pi's own session file. The call is debounced
  (10 seconds), so a burst of turns makes one request.
- **On quit** it does one last sync and writes a short handoff (what was worked on, which files
  were touched, where you left off).
- **Tools for the agent:** `memory_search` (search history, or expand one result by id) and
  `memory_save` (store a fact).
- **Commands for you:** `/memory` (status for the current folder) and `/handoff` (write the
  handoff now, without quitting).
- **Fails open.** Every request has an 800ms timeout and never throws. If ira-memory is down,
  the session runs as if the extension were not there. After 3 failed syncs in a row, it stops
  trying until the next session.

## Install

Pi loads extensions from these places (see pi's `docs/extensions.md`):

- `~/.pi/agent/extensions/*/index.ts` — global, all projects
- `.pi/extensions/...` — project-local, same layout

Copy or symlink this folder to one of them, for example:

```bash
ln -s "$(pwd)/integrations/pi" ~/.pi/agent/extensions/memory
```

Start pi, or run `/reload` in a running session. Run `/memory` to check that it can reach
ira-memory.

The extension imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox`.
Pi provides these when it loads the extension, so you do not install them here.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `IRA_URL` | `http://127.0.0.1:7775` | Where ira-memory listens. A trailing slash is removed. |
| `IRA_API_TOKEN` | unset | If set, sent as `Authorization: Bearer <token>` on every request. Use the same value as the server. |

Set them in the shell that starts pi.

### Which session files the server accepts

The extension sends only a file path. The server reads the file itself, and only if it is
inside pi's sessions directory. The server picks that directory from, in order:

1. `IRA_PI_SESSIONS_DIR`
2. `PI_CODING_AGENT_SESSION_DIR`
3. `$PI_CODING_AGENT_DIR/sessions`
4. `~/.pi/agent/sessions`

If you moved pi's sessions, set the same variable for the server. See `../../src/pi-capture.ts`.
The server and pi must share a filesystem, because the server reads the file from disk.

## Tagging scheme: `project:<slug>`

The tag comes from the session's working directory (`slug.ts`):

| cwd | tag |
|---|---|
| `~/Projects/ira-memory` (any depth below it) | `project:ira-memory` |
| `~/Projects` itself (with or without trailing slash) | `project:Projects` (deliberate catch-all, not a bug) |
| anywhere else, e.g. `~/work/notes` | `project:notes` (basename fallback) |
| empty cwd only | `null`, nothing is recorded |

Nested paths collapse to the project root, so `~/Projects/ira-memory/src/db` is
`project:ira-memory`. The rules must match the server's `deriveProjectSlug` in
`../../src/slug.ts`. Both sides test the same fixtures.

## Two storage tracks

The transcript and the handoff go to different endpoints on purpose. They fail in different
ways and have different readers.

1. **Full transcript → messages table.** `POST /session/sync` carries
   `{sessionFile, sessionId, cwd, final}`: a path, never message content. ira-memory reads
   pi's session file and stores user and assistant text, tool calls and tool results. Secrets
   are redacted before storage. Syncing the same file again only imports new entries. The final
   sync on quit also runs summarization and decision extraction on the server.
2. **Handoff → one fact.** `journal.ts` turns each turn into one short local line. On quit,
   `handoff.ts` builds a summary of at most 1200 characters from those lines and posts it
   to `POST /memory` with tags `["project:<slug>", "pi:handoff"]`. No LLM call happens on
   quit. A session with no journal lines writes no handoff.

## Files

- `index.ts` — hooks, commands and tools
- `client.ts` — HTTP client (`API.md` lists the endpoints)
- `slug.ts` — project tag from cwd
- `rules.ts` — formats the standing rules
- `journal.ts`, `handoff.ts` — local turn digest and the handoff text
- `*.test.ts` — tests

## Tests

```bash
cd integrations/pi && bun test
```

The root `tsconfig.json` only covers `src/`, so `bun run typecheck` does not check this folder.
