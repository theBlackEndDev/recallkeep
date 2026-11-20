import { test, expect } from "bun:test";
import { injection, lastAgyReply } from "./hook.js";
import { formatDecisions, formatRecent, formatRules } from "./agent-memory.js";

test("claude and codex inject through hookSpecificOutput.additionalContext", () => {
  for (const h of ["claude", "codex"] as const) {
    expect(JSON.parse(injection(h, "session-start", "ctx"))).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
    });
    expect(JSON.parse(injection(h, "prompt", "ctx")).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  }
});

test("agy injects a system message at session start and an ephemeral message per prompt", () => {
  expect(JSON.parse(injection("agy", "session-start", "ctx"))).toEqual({ injectSteps: [{ systemMessage: { systemMessage: "ctx" } }] });
  expect(JSON.parse(injection("agy", "prompt", "ctx"))).toEqual({ injectSteps: [{ ephemeralMessage: "ctx" }] });
});

test("nothing to inject prints nothing", () => {
  expect(injection("claude", "prompt", "")).toBe("");
});

test("lastAgyReply returns the newest non-empty model response", () => {
  const transcript = [
    { source: "USER_EXPLICIT", type: "USER_INPUT", content: "hi" },
    { source: "MODEL", type: "PLANNER_RESPONSE", content: "first" },
    { source: "MODEL", type: "PLANNER_RESPONSE", content: "final answer" },
    { source: "MODEL", type: "PLANNER_RESPONSE", content: "" },
  ]
    .map((s) => JSON.stringify(s))
    .join("\n");
  expect(lastAgyReply(transcript + "\n{torn")).toBe("final answer");
  expect(lastAgyReply("")).toBeUndefined();
});

const fact = (content: string, tags: string[], created_at: string) => ({ id: content, content, tags, created_at });

test("session-start blocks: rules oldest first, decisions newest first, recent facts skip decisions and digests", () => {
  expect(formatRules([fact("[global] b", [], "2026-02"), fact("a", [], "2026-01")])).toBe(
    "## Standing rules (RecallKeep, every project)\n- a\n- b\n",
  );
  expect(formatDecisions([fact("old", ["decision"], "2026-01"), fact("new", ["decision"], "2026-02"), fact("x", [], "2026-03")])).toBe(
    "## Locked decisions for this project\n- new\n- old\n",
  );
  const recent = formatRecent([fact("d", ["decision"], "2026-01-01"), fact("s", ["session-summary"], "2026-01-01"), fact("keep", [], "2026-01-02")]);
  expect(recent).toBe("## Recent facts for this project\n- (2026-01-02) keep\n");
});
