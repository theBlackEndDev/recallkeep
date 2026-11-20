// Fixture-driven test for pi-capture.ts's parsing logic: thinking blocks
// dropped (D1), off-path branch tagging (D3), redaction before store (D8),
// idempotent re-import. Requires a live Postgres (uses the real store), same
// as test-e2e.ts — not a pure-function test like slug.test.ts.
//
// DB isolation: only runs when IRA_TEST_DATABASE_URL points at a throwaway,
// already-migrated database. Bun auto-loads .env, so the real
// MEMORY_DATABASE_URL is always present in the environment — it is
// overwritten below BEFORE anything that loads the Prisma client is imported
// (hence the dynamic imports). The session fixture lives in a temp dir
// (IRA_PI_SESSIONS_DIR, read by pi-capture.ts at module load), never in the
// real ~/.pi/agent/sessions. Embeddings are disabled (IRA_LLM_PROVIDER=none);
// nothing here needs them — the "tool rows are never embedded" check holds
// trivially with embeddings off and is covered by the code path, not the API.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB_URL = process.env.IRA_TEST_DATABASE_URL;
if (TEST_DB_URL) {
  process.env.MEMORY_DATABASE_URL = TEST_DB_URL;
  process.env.IRA_LLM_PROVIDER = "none";
} else {
  delete process.env.MEMORY_DATABASE_URL;
}

function buildFixture(sessionId: string) {
  // Tree shape (extended for Phase 4: tool calls + tool results):
  //   root(user) -> a1(assistant: thinking+text+toolCall tc1)
  //     -> tr1(toolResult for tc1 — contains a secret, real bug: this is
  //            where the ONE actual secret found in Phase 3 backfill lived,
  //            in a tool result, not in assistant prose)
  //       -> b1(user "abandoned branch") [off-path sibling of the a2 chain]
  //       -> a2(user "the real second turn") -> a4(assistant: toolCall tc2
  //            ONLY, no visible text — tests that a text-less assistant turn
  //            still yields a tool-call row even though it yields no text row)
  //         -> tr2(toolResult for tc2, OVERSIZED — tests the 2KB cap)
  //           -> a3(assistant, has its own secret) [LEAF]
  const OVERSIZED_RESULT = "line of tool output ".repeat(150); // ~3000 chars, > MAX_TOOLRESULT_CHARS (2000)
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/home/dev/Projects/ira-memory" }),
    JSON.stringify({
      type: "message", id: "root", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hello, this is definitely more than fifty characters long for embedding" },
    }),
    JSON.stringify({
      type: "message", id: "a1", parentId: "root", timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning that must never be stored per D1, padded to be long enough to matter for length checks" },
          { type: "text", text: "Here is my visible answer, long enough to pass the fifty character embed gate easily." },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "env | grep API" } },
        ],
      },
    }),
    // Realistic secret in a TOOL RESULT, not assistant prose — mirrors the
    // actual leak found during Phase 3 backfill (an Anthropic session key
    // sitting in a bash toolResult).
    JSON.stringify({
      type: "message", id: "tr1", parentId: "a1", timestamp: "2026-01-01T00:00:02.500Z",
      message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: false,
        content: [{ type: "text", text: "OPENAI_API_KEY=REDACTED-FIXTURE-2\n" }] },
    }),
    // off-path branch: parented on tr1, but the leaf (a3) does not descend from this.
    JSON.stringify({
      type: "message", id: "b1", parentId: "tr1", timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: "this branch got abandoned when the user edited their message instead, long enough" },
    }),
    JSON.stringify({
      type: "message", id: "a2", parentId: "tr1", timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "user", content: "the real second turn that stays on the leaf path, long enough to embed too" },
    }),
    // Assistant turn that is 100% tool call, no visible text — must still
    // yield a tool-call row even though it yields no text row.
    JSON.stringify({
      type: "message", id: "a4", parentId: "a2", timestamp: "2026-01-01T00:00:04.500Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "/tmp/big-log.txt" } }] },
    }),
    JSON.stringify({
      type: "message", id: "tr2", parentId: "a4", timestamp: "2026-01-01T00:00:05.000Z",
      message: { role: "toolResult", toolCallId: "tc2", toolName: "read", isError: false,
        content: [{ type: "text", text: OVERSIZED_RESULT }] },
    }),
    // Realistic (high-entropy) fake key — real scanners (Phase 2: betterleaks/
    // gitleaks) reject low-entropy/sequential strings like "abcdefghij..." as
    // non-random, same as they'd reject a real secret-shaped placeholder. A
    // fixture has to look like an actual leaked key to prove the engine works.
    JSON.stringify({
      type: "message", id: "a3", parentId: "tr2", timestamp: "2026-01-01T00:00:05.500Z",
      message: { role: "assistant", content: [{ type: "text", text: "OPENAI_API_KEY=REDACTED-FIXTURE-2 is now set, done." }] },
    }),
  ];
  return { lines, OVERSIZED_RESULT };
}

describe.skipIf(!TEST_DB_URL)("pi-capture import (needs IRA_TEST_DATABASE_URL)", () => {
  type Row = Awaited<ReturnType<typeof import("./client.js").prisma.message.findMany>>[number];

  let prisma: typeof import("./client.js").prisma;
  let flushPendingEmbeds: typeof import("./embed.js").flushPendingEmbeds;
  let importPiSession: typeof import("./pi-capture.js").importPiSession;
  let tmpRoot: string;
  let fixtureDir: string;
  let file: string;
  let OVERSIZED_RESULT: string;
  let result: Awaited<ReturnType<typeof import("./pi-capture.js").importPiSession>>;
  let byEntryId: Map<unknown, Row>;

  beforeAll(async () => {
    // pi-capture.ts validates sessionFile is under SESSIONS_ROOT, which it
    // reads from IRA_PI_SESSIONS_DIR once at module load — so point it at a
    // temp dir first, then import.
    tmpRoot = mkdtempSync(join(tmpdir(), "ira-pi-capture-test-"));
    process.env.IRA_PI_SESSIONS_DIR = tmpRoot;

    ({ prisma } = await import("./client.js"));
    ({ flushPendingEmbeds } = await import("./embed.js"));
    ({ importPiSession } = await import("./pi-capture.js"));

    fixtureDir = mkdtempSync(join(tmpRoot, "test-fixture-"));
    const sessionId = `test-${Date.now()}`;
    file = join(fixtureDir, `${sessionId}.jsonl`);
    const fx = buildFixture(sessionId);
    OVERSIZED_RESULT = fx.OVERSIZED_RESULT;
    writeFileSync(file, fx.lines.join("\n") + "\n");

    result = await importPiSession({ sessionFile: file });
    const rows = await prisma.message.findMany({
      where: { sessionId: result.sessionRowId },
      orderBy: { createdAt: "asc" },
    });
    byEntryId = new Map(rows.map((r) => [(r.metadata as any)?.piEntryId, r]));
  });

  afterAll(async () => {
    if (result?.sessionRowId) {
      await flushPendingEmbeds();
      await prisma.message.deleteMany({ where: { sessionId: result.sessionRowId } });
      await prisma.session.deleteMany({ where: { id: result.sessionRowId } });
    }
    if (prisma) await prisma.$disconnect();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  // root(1) + a1 text(1) + a1 toolCall tc1(1) + tr1(1) + b1(1) + a2(1) +
  // a4 toolCall tc2(1, no text row — a4's own text is empty) + tr2(1) + a3(1) = 9
  test("imported 9 rows (5 text/user-assistant + 2 tool calls + 2 tool results)", () => {
    expect(result.imported).toBe(9);
  });
  test("a4's own text portion is empty (toolCall-only turn)", () => {
    expect(result.skippedEmpty).toBe(1);
  });
  test("project resolved from cwd", () => {
    expect(result.project).toBe("ira-memory");
  });

  test("root: role is user", () => {
    expect(byEntryId.get("root")?.role).toBe("user");
  });
  test("root: on leaf path", () => {
    expect((byEntryId.get("root")?.metadata as any)?.offPath).toBeFalsy();
  });

  test("a1: role is assistant", () => {
    expect(byEntryId.get("a1")?.role).toBe("assistant");
  });
  test("a1: visible text stored", () => {
    expect(byEntryId.get("a1")?.content.includes("visible answer")).toBe(true);
  });
  test("a1: thinking block dropped (D1)", () => {
    expect(byEntryId.get("a1")?.content.includes("internal reasoning")).toBe(false);
  });
  test("a1: toolCall not stored as text (Phase 4 scope)", () => {
    expect(byEntryId.get("a1")?.content.includes("bash")).toBe(false);
  });
  test("a1: on leaf path", () => {
    expect((byEntryId.get("a1")?.metadata as any)?.offPath).toBeFalsy();
  });

  test("b1: still imported despite being off-path (D3)", () => {
    expect(byEntryId.get("b1")?.role).toBe("user");
  });
  test("b1: tagged offPath=true (D3)", () => {
    expect((byEntryId.get("b1")?.metadata as any)?.offPath).toBe(true);
  });

  test("a2: on leaf path (not off-path)", () => {
    expect((byEntryId.get("a2")?.metadata as any)?.offPath).toBeFalsy();
  });

  test("a3: secret redacted before store (D8)", () => {
    const a3Row = byEntryId.get("a3");
    expect(a3Row).toBeDefined();
    expect(a3Row!.content.includes("Hj8kLp2QmN9vXyT4wRfB6cAeZgU3oIiKdSnJ7hMlPqWxCvFtYbEr")).toBe(false);
  });
  test("a3: redaction placeholder present", () => {
    expect(byEntryId.get("a3")?.content.includes("[REDACTED]")).toBe(true);
  });
  test("a3: metadata.redacted=true", () => {
    expect((byEntryId.get("a3")?.metadata as any)?.redacted).toBe(true);
  });
  test("a3: metadata.redactionEngine is a real tier", () => {
    const engine = (byEntryId.get("a3")?.metadata as any)?.redactionEngine as string | undefined;
    const validEngines = ["betterleaks", "gitleaks", "heuristic", "betterleaks+heuristic", "gitleaks+heuristic"];
    expect(validEngines).toContain(engine as string);
  });

  // --- Phase 4: tool call row (tc1, inside a1) ---
  test("tc1: role is assistant (it's part of the assistant's turn)", () => {
    expect(byEntryId.get("a1:call:tc1")?.role).toBe("assistant");
  });
  test("tc1: toolName=bash", () => {
    expect(byEntryId.get("a1:call:tc1")?.toolName).toBe("bash");
  });
  test("tc1: content is a searchable marker naming the tool", () => {
    expect(byEntryId.get("a1:call:tc1")?.content.includes("bash")).toBe(true);
  });
  test("tc1: toolInput mirrors the redacted content (same safe value, structured column too)", () => {
    const tc1Row = byEntryId.get("a1:call:tc1");
    expect(tc1Row?.toolInput).toBe(tc1Row?.content as any);
  });
  test("tc1: synthetic piEntryId distinct from a1's own text row", () => {
    expect((byEntryId.get("a1:call:tc1")?.metadata as any)?.piEntryId).toBe("a1:call:tc1");
  });

  // --- Phase 4: tool result row (tr1) — the actual secret lived here in the real bug ---
  test("tr1: role is tool", () => {
    expect(byEntryId.get("tr1")?.role).toBe("tool");
  });
  test("tr1: toolName copied from the toolResult entry", () => {
    expect(byEntryId.get("tr1")?.toolName).toBe("bash");
  });
  test("tr1: secret in a TOOL RESULT is also redacted (this is the real bug this phase closes)", () => {
    const tr1Row = byEntryId.get("tr1");
    expect(tr1Row).toBeDefined();
    expect(tr1Row!.content.includes("Hj8kLp2QmN9vXyT4wRfB6cAeZgU3oIiKdSnJ7hMlPqWxCvFtYbEr")).toBe(false);
  });
  test("tr1: metadata.redacted=true", () => {
    expect((byEntryId.get("tr1")?.metadata as any)?.redacted).toBe(true);
  });
  test("tr1: toolOutput.isError carried through", () => {
    expect((byEntryId.get("tr1")?.toolOutput as any)?.isError).toBe(false);
  });

  // --- Phase 4: tool call with NO sibling text row (a4 was 100% tool call) ---
  test("tc2: toolName=read, imported even though a4 produced no text row", () => {
    expect(byEntryId.get("a4:call:tc2")?.toolName).toBe("read");
  });
  test("a4: no text row exists at all (its own piEntryId was never stored — only the synthetic call row was)", () => {
    expect(byEntryId.has("a4")).toBe(false);
  });

  // --- Phase 4: oversized tool result gets capped, original length recorded ---
  test("tr2: capped at IRA_PI_TOOLRESULT_CAP (2000)", () => {
    expect(byEntryId.get("tr2")!.content.length).toBeLessThanOrEqual(2000);
  });
  test("tr2: metadata.originalLength records the pre-cap (trimmed) size", () => {
    // trim() runs before capping (extractText().trim()), so the recorded length is the trimmed size, not the raw repeat() length.
    expect((byEntryId.get("tr2")?.metadata as any)?.originalLength).toBe(OVERSIZED_RESULT.trim().length);
  });

  // --- Phase 4: tool rows are never embedded (plan: "tool results never embedded") ---
  test("no tool-call or tool-result row was embedded", async () => {
    await flushPendingEmbeds();
    const toolRowIds = ["a1:call:tc1", "tr1", "a4:call:tc2", "tr2"].map((k) => byEntryId.get(k)!.id);
    const toolEmbeds = await prisma.messageEmbedding.count({ where: { messageId: { in: toolRowIds } } });
    expect(toolEmbeds).toBe(0);
  });

  // Idempotent re-import: same file, no new rows. These two run in order and
  // before the final:true test below (bun runs tests in declaration order).
  test("re-import adds nothing new", async () => {
    const second = await importPiSession({ sessionFile: file });
    expect(second.imported).toBe(0);
  });
  test("re-import skips all 9 as already-imported", async () => {
    const second = await importPiSession({ sessionFile: file });
    expect(second.skippedExisting).toBe(9);
  });

  // final: true closes the session.
  test("final:true sets endedAt", async () => {
    await importPiSession({ sessionFile: file, final: true });
    const closed = await prisma.session.findUnique({ where: { id: result.sessionRowId } });
    expect(closed?.endedAt).not.toBeNull();
  });
});
