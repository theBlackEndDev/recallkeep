#!/usr/bin/env bun
/**
 * cc-capture.ts - Claude Code SessionEnd hook for capturing conversations.
 *
 * Reads the CC hook JSON from stdin, parses the transcript.jsonl,
 * and bulk-imports user/assistant messages into recallkeep.
 *
 * Usage (called automatically by Claude Code SessionEnd hook):
 *   echo '{"session_id":"...","transcript_path":"..."}' | bun run src/cc-capture.ts
 *
 * Can also be run manually to import a transcript:
 *   bun run src/cc-capture.ts --transcript /path/to/transcript.jsonl --session-id abc123
 */

import { readFileSync, appendFileSync } from "fs";
import { hostname } from "os";
import { redactBatch } from "./redact.js";

const DEBUG_LOG = "/tmp/recallkeep-cc-capture.log";
function dlog(msg: string) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

interface CCHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
}

interface TranscriptLine {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    model?: string;
  };
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  uuid?: string;
}

function extractContent(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("\n");
  }
  return "";
}

export interface CapturedMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  timestamp?: string;
}

const MAX_MESSAGE_CHARS = 50_000;

/**
 * Parse a Claude Code JSONL transcript into user and assistant messages,
 * skipping malformed lines, and redact all extracted message bodies in one batch.
 */
export async function extractMessages(transcriptData: string): Promise<CapturedMessage[]> {
  const lines = transcriptData
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as TranscriptLine;
      } catch {
        return null;
      }
    })
    .filter((l): l is TranscriptLine => l !== null);

  const messages: CapturedMessage[] = [];

  for (const line of lines) {
    if (line.type === "user" && line.message?.role === "user") {
      const content = extractContent(line.message.content);
      if (content && content.length >= 2) {
        messages.push({
          role: "user",
          content: content.slice(0, MAX_MESSAGE_CHARS),
          timestamp: line.timestamp,
        });
      }
    } else if (
      (line.type === "assistant" || line.type === "result") &&
      line.message?.role === "assistant"
    ) {
      const content = extractContent(line.message.content);
      if (content && content.length >= 2) {
        messages.push({
          role: "assistant",
          content: content.slice(0, MAX_MESSAGE_CHARS),
          model: line.message.model,
          timestamp: line.timestamp,
        });
      }
    }
  }

  if (messages.length === 0) return [];

  const batch = await redactBatch(messages.map((m) => m.content));
  return messages.map((m, i) => ({
    ...m,
    content: batch.texts[i],
  }));
}

async function main() {
  let ccSessionId: string;
  let transcriptPath: string;
  let cwd = process.cwd();

  // Parse args: either from stdin (hook mode) or CLI flags (manual mode)
  const args = process.argv.slice(2);
  const manualIdx = args.indexOf("--transcript");

  if (manualIdx !== -1) {
    // Manual mode
    transcriptPath = args[manualIdx + 1];
    const sidIdx = args.indexOf("--session-id");
    ccSessionId = sidIdx !== -1 ? args[sidIdx + 1] : `manual-${Date.now()}`;
  } else {
    // Hook mode: read JSON from stdin.
    // Use fd 0 rather than "/dev/stdin" — the latter raises ENXIO in Bun
    // when the parent process's stdin fd is in certain states (common for
    // Claude Code hook subprocesses).
    let input = "";
    try {
      input = readFileSync(0, "utf-8").trim();
    } catch (err) {
      dlog(`exit: stdin read failed: ${err}`);
      process.exit(0);
    }
    if (!input) {
      dlog("exit: empty stdin");
      process.exit(0);
    }
    const hookInput: CCHookInput = JSON.parse(input);
    ccSessionId = hookInput.session_id;
    transcriptPath = hookInput.transcript_path;
    cwd = hookInput.cwd || cwd;
    dlog(
      `hookInput session=${ccSessionId?.slice(0, 8)} reason=${(hookInput as any).reason ?? "?"} event=${hookInput.hook_event_name ?? "?"} transcript=${transcriptPath ?? "<none>"} cwd=${cwd}`
    );

    if (!transcriptPath) {
      dlog("exit: no transcript_path in hook input");
      process.exit(0);
    }
  }

  // Read and parse transcript
  let transcriptData: string;
  try {
    transcriptData = readFileSync(transcriptPath, "utf-8");
  } catch (err) {
    dlog(`exit: cannot read transcript ${transcriptPath}: ${err}`);
    process.exit(0);
  }

  const messages = await extractMessages(transcriptData);

  dlog(`parsed transcript: ${messages.length} user+assistant messages`);

  if (messages.length === 0) {
    // Nothing to capture (e.g., empty session or only tool calls)
    dlog("exit: no user/assistant messages in transcript");
    process.exit(0);
  }

  const { openSession, closeSession, storeMessage, flushPendingEmbeds, prisma } = await import("./index.js");

  try {
    // Check if this CC session was already imported (idempotency)
    const existing = await prisma.session.findFirst({
      where: { metadata: { path: ["ccSessionId"], equals: ccSessionId } },
    });

    if (existing) {
      dlog(`exit: already imported (session row ${existing.id})`);
      return;
    }

    // Derive a title from the first user message
    const firstMsg = messages.find((m) => m.role === "user");
    const title = firstMsg
      ? firstMsg.content.slice(0, 80) + (firstMsg.content.length > 80 ? "..." : "")
      : "Claude Code session";

    // Open session
    const session = await openSession({
      channel: "claude-code",
      title,
      hostId: hostname(),
      metadata: {
        ccSessionId,
        cwd,
        capturedAt: new Date().toISOString(),
        messageCount: messages.length,
      },
    });

    // Store messages
    for (const msg of messages) {
      await storeMessage({
        sessionId: session.id,
        role: msg.role,
        content: msg.content.slice(0, 50000), // Cap at 50k chars
        model: msg.model,
      });
    }

    // Close session WITHOUT summary + learn — those are derived data and
    // can take 5-10s of OpenAI time, during which Claude Code has been
    // observed to kill the hook subprocess before completion. We leave the
    // session marked ended_at=now with no summary, and rely on
    // `cli.ts summarize-pending` (or a maintenance pass) to backfill
    // summaries and learnings out-of-band.
    try {
      await closeSession(session.id, { summarize: false, learn: false });
    } catch (err) {
      dlog(`closeSession error (non-fatal): ${err}`);
      console.error(`[cc-capture] closeSession error (non-fatal): ${err}`);
    }

    console.error(
      `[cc-capture] Captured ${messages.length} messages from CC session ${ccSessionId.slice(0, 8)}...`
    );
  } finally {
    // Drain in-flight embed calls before disconnecting the Prisma engine.
    await flushPendingEmbeds();
    await prisma.$disconnect();
    dlog("done");
  }
}

if (import.meta.main) {
  // Diagnostic: record every invocation before any parsing so even crashes leave a trace.
  dlog(`invoked pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))}`);

  main().catch((err) => {
    dlog(`fatal: ${err?.stack ?? err}`);
    console.error(`[cc-capture] Fatal: ${err}`);
  });
}
