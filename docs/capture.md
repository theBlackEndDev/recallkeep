# Session capture

This file covers how conversations get into ira-memory automatically, for Claude Code and pi.

This file covers how conversations get into ira-memory automatically. There are two capture paths. Claude Code uses a `SessionEnd` hook that reads a finished transcript. pi uses an extension that posts a file path after every turn. The pi extension itself is documented in [integrations/pi/README.md](../integrations/pi/README.md).

## Claude Code session capture

Capture every Claude Code conversation into ira-memory automatically.

### Install

```bash
bun run src/cli.ts install-hooks
```

This adds a `SessionEnd` hook to `~/.claude/settings.json`. When a session ends, the full transcript is parsed and stored. That includes user prompts, assistant responses, session metadata, and an auto-generated summary.

If the installer cannot find `bun` on its PATH, it stops with an error. Set `IRA_BUN_PATH` to the absolute path of your bun binary and run it again. Claude Code starts hooks with a minimal PATH, so the installer writes an absolute path into the hook command.

### What gets captured

- All user and assistant messages, redacted in a single batch through the redaction chain before storage. Tool calls are left out to reduce noise.
- Session metadata: working directory, timestamp, and the Claude Code session ID.
- An LLM-generated summary, written when the session closes.
- Learnings, such as decisions, mistakes, and best practices.

The `SessionEnd` hook skips the summary call. A summary takes several seconds, and a hook subprocess can be killed before it finishes. The summary is produced later by `summarize-pending`, which the cron script runs hourly.

### Manual capture

Import one transcript file:

```bash
bun run src/cli.ts capture --transcript ~/.claude/sessions/<id>/transcript.jsonl
```

### Verify

After a Claude Code session ends:

```bash
bun run src/cli.ts stats       # message and session counts
bun run src/cli.ts sessions    # list captured sessions
```

## Lifecycle hooks for other agents

Claude Code, Codex, and Antigravity can also call ira-memory at three points in a turn: session start, prompt, and stop. The `hook` command handles all three. Wire it up with the example files in `integrations/`:

- `integrations/claude-code/settings.json`: Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`).
- `integrations/codex/config.toml`: Codex CLI configuration. It also registers the `mcp` server. Codex hooks must be inline `[hooks]` tables in `config.toml`. Hooks in a project's `.codex/hooks.json` did not load in testing.
- `integrations/antigravity/hooks.json`: Antigravity CLI hooks.
- `integrations/AGENTS.md`: a block to paste into your `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`, so the agent knows when to use the memory tools.

Replace `/PATH/TO/ira-memory` in the examples with the absolute path to your checkout. The command is `bun /path/to/ira-memory/src/cli.ts hook <harness> <event>`. See [cli.md](cli.md#the-hook-command) for what each event does.

A hook never blocks the agent. If the memory service is down, the hook prints nothing and exits `0`.

## pi session capture

Capture full **pi** sessions (`@earendil-works/pi-coding-agent`). Every turn is captured, for both roles, without truncation. The source is the transcript pi already writes to `~/.pi/agent/sessions/**/*.jsonl`.

This is the counterpart of Claude Code capture. It uses the same steps: parse, extract, de-duplicate, store. The difference is the trigger. The pi extension posts a file path after each turn, and the server reads the file itself. Claude Code's hook reads a finished transcript instead.

### How it is wired

The pi extension sends `POST /session/sync` after each settled turn. The call is debounced by 10 seconds. The extension sends one more call, awaited, when the session shuts down. Each call carries only a `{sessionFile, cwd, final}` payload. It never carries message content.

`src/pi-capture.ts` reads the file and imports it:

- **User and assistant text** is stored in full, up to `IRA_PI_MESSAGE_CAP` characters (default `50000`). `thinking` blocks are dropped. They depend on the model, are absent on some providers, and are usually restated in the visible answer.
- **Tool calls** get their own row, with role `assistant`, `tool_name` and `tool_input` set, and a short searchable marker as the content.
- **Tool results** get their own row, with role `tool`, `tool_name` and `tool_output` set. The content is cut to `IRA_PI_TOOLRESULT_CAP` characters (default `2000`). Tool results are not embedded. Most raw transcript volume is tool output, and embedding it would crowd out the real conversation in semantic recall.
- **Idempotent per entry.** Each row stores `metadata.piEntryId`. Re-syncing a growing file imports only new entries. Entries on an abandoned branch are still imported, but are tagged `metadata.offPath: true` and left out of default recall.
- **Project slug.** The session row gets `metadata.project` from the same `deriveProjectSlug` rule used everywhere else.

### Which files the server will read

The sync endpoint reads a path it is given, so it accepts only files under pi's sessions directory. The directory is chosen in this order:

1. `IRA_PI_SESSIONS_DIR`
2. `PI_CODING_AGENT_SESSION_DIR`
3. `$PI_CODING_AGENT_DIR/sessions`
4. `~/.pi/agent/sessions`

A path outside this directory returns `403`.

### Retrieval

- `GET /conversation/recall?q=&project=&limit=` runs hybrid full-text and vector search over raw messages, scoped by project or channel. The pi `memory_search` tool calls this route.
- `GET /conversation/message/<id>` fetches one message in full. Use it to expand a truncated result.
- **Session summaries** run when the session closes. The pi capture path can run them inline, because it runs in a long-lived server process. The Claude Code hook cannot, for the reason given above.
- **Catch-all topic tags.** Sessions whose working directory is exactly the bare projects root (for example `~/Projects`) are a deliberate catch-all, not a bug. For each generated summary topic, these sessions get a companion fact tagged `project:Projects`, `pi:session-topic`, and `topic:<x>`. This keeps that bucket searchable by subject, not only by date.

### Decisions

When a pi session closes, the decisions pass (`src/decisions.ts`) extracts locked decisions. It stores them as `DECISION` facts with tier `LONG_TERM`. The pi extension then injects the current project's decisions into the system prompt at the start of each session, under `## Locked decisions for this project`.

The injection exists because a new session had no way to tell a settled decision from an open discussion, and it reopened questions that were already closed. With the injection, a fresh session lists settled items as settled and cites where they were decided.

### Redaction

Before any message is stored (in both pi and Claude Code transcript capture), its text is redacted. The redaction runs before the row is written and before the embedding is computed, so a secret never reaches the database or the embeddings API. All pending messages in one sync or capture are redacted in a single batch. See [privacy.md](privacy.md#redaction) for the redaction engines and their limits.

Redaction only runs at import time. If the redaction engines improve later, existing rows do not change on their own. Run `redact-rescan` to re-check stored rows. See [privacy.md](privacy.md#detect-sensitive-and-redact-rescan).

## Related

- [integrations/pi/README.md](../integrations/pi/README.md): installing and configuring the pi extension.
- [integrations/pi/API.md](../integrations/pi/API.md): the extension's client view of the API.
- [cli.md](cli.md#capture-and-integrations): the `hook` command, used by Claude Code, Codex, and Antigravity.
- [how-it-works.md](how-it-works.md): what happens to captured data after it is stored.
