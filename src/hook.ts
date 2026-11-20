/**
 * Lifecycle hooks for coding agents. One command, three harnesses:
 *
 *   bun /path/to/recallkeep/src/cli.ts hook <claude|codex|agy> <session-start|prompt|stop>
 *
 *   session-start  inject standing rules, locked decisions and recent facts
 *   prompt         log the user's prompt and inject facts related to it
 *   stop           log the assistant's final reply for the turn
 *
 * The harness pipes its event JSON on stdin. Every failure is swallowed: the
 * hook exits 0 with no output, so memory being down never blocks an agent.
 *
 * Payload contracts (verified live 2026-11-20, see docs/capture.md):
 *   claude, codex  session_id, cwd, prompt (UserPromptSubmit),
 *                  last_assistant_message (Stop); inject with
 *                  hookSpecificOutput.additionalContext
 *   agy            conversationId, cwd, lastUserInput, invocationNum
 *                  (PreInvocation), transcriptPath; inject with injectSteps.
 *                  agy has no prompt-submit event (PreInvocation runs before
 *                  every model call) and no reply field on Stop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logTurn, promptContext, sessionContext } from "./agent-memory.js";

const HARNESSES = ["claude", "codex", "agy"] as const;
const EVENTS = ["session-start", "prompt", "stop"] as const;
type Harness = (typeof HARNESSES)[number];
type Event = (typeof EVENTS)[number];

interface Input {
  sessionId: string;
  cwd?: string;
  prompt?: string;
  reply?: string;
  invocationNum?: number;
  transcriptPath?: string;
}

function normalize(harness: Harness, raw: any): Input {
  if (harness === "agy") {
    return {
      sessionId: String(raw.conversationId ?? "unknown"),
      cwd: raw.cwd ?? raw.workspacePaths?.[0],
      prompt: raw.lastUserInput,
      invocationNum: typeof raw.invocationNum === "number" ? raw.invocationNum : undefined,
      transcriptPath: raw.transcriptPath,
    };
  }
  return {
    sessionId: String(raw.session_id ?? "unknown"),
    cwd: raw.cwd,
    prompt: raw.prompt,
    reply: raw.last_assistant_message ?? undefined,
  };
}

/** Last non-empty model reply in an agy transcript_full.jsonl. */
export function lastAgyReply(transcript: string): string | undefined {
  const lines = transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const step = JSON.parse(lines[i]);
      if (step.source === "MODEL" && step.type === "PLANNER_RESPONSE" && typeof step.content === "string" && step.content.trim()) {
        return step.content;
      }
    } catch {}
  }
  return undefined;
}

/** What the harness expects on stdout to add `text` to the model's context. */
export function injection(harness: Harness, event: Event, text: string): string {
  if (!text) return "";
  if (harness === "agy") {
    const step = event === "session-start" ? { systemMessage: { systemMessage: text } } : { ephemeralMessage: text };
    return JSON.stringify({ injectSteps: [step] });
  }
  const hookEventName = event === "session-start" ? "SessionStart" : "UserPromptSubmit";
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

// agy fires PreInvocation before every model call in a turn, and an
// ephemeralMessage lasts one call. Recall and logging run once per turn
// (invocationNum 0); later calls in the turn reuse the cached result.
const STATE_DIR = join(process.env.RECALLKEEP_DATA_DIR ?? join(homedir(), ".recallkeep"), "hook-state");
const stateFile = (id: string) => join(STATE_DIR, `agy-${id.replace(/[^\w.-]/g, "_")}.txt`);

async function run(harness: Harness, event: Event, input: Input): Promise<string> {
  if (event === "session-start") {
    return injection(harness, event, await sessionContext(input.cwd));
  }

  if (event === "prompt") {
    if (!input.prompt) return "";
    if (harness === "agy" && (input.invocationNum ?? 0) > 0) {
      const f = stateFile(input.sessionId);
      return injection(harness, event, existsSync(f) ? readFileSync(f, "utf-8") : "");
    }
    const [context] = await Promise.all([
      promptContext(input.prompt, input.cwd),
      logTurn({ harness, sessionId: input.sessionId, role: "user", content: input.prompt, cwd: input.cwd }),
    ]);
    if (harness === "agy") {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(stateFile(input.sessionId), context);
    }
    return injection(harness, event, context);
  }

  // stop
  let reply = input.reply;
  if (harness === "agy" && input.transcriptPath && existsSync(input.transcriptPath)) {
    reply = lastAgyReply(readFileSync(input.transcriptPath, "utf-8"));
  }
  if (reply) await logTurn({ harness, sessionId: input.sessionId, role: "assistant", content: reply, cwd: input.cwd });
  return "";
}

export async function runHook(args: string[]): Promise<void> {
  const [harness, event] = args as [Harness, Event];
  if (!HARNESSES.includes(harness) || !EVENTS.includes(event)) {
    console.error(`usage: hook <${HARNESSES.join("|")}> <${EVENTS.join("|")}>`);
    process.exitCode = 2;
    return;
  }
  try {
    const raw = JSON.parse((await Bun.stdin.text()) || "{}");
    const out = await run(harness, event, normalize(harness, raw));
    if (out) process.stdout.write(out + "\n");
  } catch (e) {
    if (process.env.RECALLKEEP_HOOK_DEBUG) console.error("[recallkeep hook]", e);
  }
}
