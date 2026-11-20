<!-- Paste into your AGENTS.md, CLAUDE.md or GEMINI.md so the agent knows when to use memory. -->
## Memory (RecallKeep)

RecallKeep is the long-term memory for this project. Its tools are available through MCP.

- Before you start work, and before you ask the user something they may have answered before,
  call `memory_search`. If no hook gave you context at session start, call `memory_context` first.
- When something is settled, call `memory_save`: decisions (add the tag `decision`), the user's
  rules and preferences (`project: "global"`), findings, and what you verified and how.
  One idea per fact, self-contained, with the date and the reason.
- Never save secrets with `memory_save`. Logged conversation turns are scanned and redacted, saved facts are not.
