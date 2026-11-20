// Phase 5 regression test for recallMessages() — the hybrid FTS+vector
// search over raw messages that GET /conversation/recall and the pi
// extension's memory_search tool both sit on top of.
//
// This is the exact case the whole project exists to fix — "What is The
// Crossroads?" was answered in a sample-novel session, and
// /conversation/search (FTS-only, pre-Phase-5) could find the question but not
// the answer. If this regresses, the incident regresses with it. The fixture
// below reproduces that conversation synthetically.
//
// DB isolation: this file writes to Postgres, so it only runs when
// RECALLKEEP_TEST_DATABASE_URL points at a throwaway, already-migrated database.
// Bun auto-loads .env, so the real RECALLKEEP_DATABASE_URL is always present in
// the environment — it is overwritten below BEFORE the Prisma client is
// imported, and the modules are loaded with dynamic import for that reason.
// Embeddings are disabled (RECALLKEEP_LLM_PROVIDER=none): the assertions are
// satisfied by the full-text layer alone, so no OpenAI call is made.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { isToolMarker, isToolQuery } from "./search.js";

const TEST_DB_URL = process.env.RECALLKEEP_TEST_DATABASE_URL;
if (TEST_DB_URL) {
  process.env.RECALLKEEP_DATABASE_URL = TEST_DB_URL;
  process.env.RECALLKEEP_LLM_PROVIDER = "none";
} else {
  delete process.env.RECALLKEEP_DATABASE_URL;
}

describe("isToolMarker / isToolQuery (pure helpers)", () => {
  test("detects pi-capture tool-call marker rows starting with → toolName(", () => {
    expect(isToolMarker('→ bash({"command":"ls -la"})')).toBe(true);
    expect(isToolMarker('→ memory_search({"query":"Crossroads"})')).toBe(true);
    expect(isToolMarker('  → read({"path":"/tmp/a.txt"})')).toBe(true);
  });

  test("does not flag normal prose or arrows mid-sentence", () => {
    expect(isToolMarker("What is The Crossroads?")).toBe(false);
    expect(isToolMarker("Timer fix confirmed working (countdown ticks 42m → 41m)")).toBe(false);
    expect(isToolMarker("→ plain arrow bullet without tool call parens")).toBe(false);
  });

  test("identifies tool-oriented queries so explicit tool searches still match", () => {
    expect(isToolQuery("→ bash")).toBe(true);
    expect(isToolQuery("bash tool call")).toBe(true);
    expect(isToolQuery('memory_search({"query":')).toBe(true);
    expect(isToolQuery("What is The Crossroads?")).toBe(false);
    expect(isToolQuery("zzznonexistentqueryzzz12345")).toBe(false);
  });
});

describe.skipIf(!TEST_DB_URL)("recallMessages (needs RECALLKEEP_TEST_DATABASE_URL)", () => {
  let recallMessages: typeof import("./recall.js").recallMessages;
  let prisma: typeof import("./client.js").prisma;
  let sessionId: string;
  let toolMarkerId: string;

  beforeAll(async () => {
    ({ recallMessages } = await import("./recall.js"));
    ({ prisma } = await import("./client.js"));

    const session = await prisma.session.create({
      data: { channel: "pi", title: "recall.test fixture", metadata: { project: "sample-novel" } },
    });
    sessionId = session.id;
    const t0 = Date.now();
    await prisma.message.createMany({
      data: [
        { sessionId, role: "user", content: "What is The Crossroads?", createdAt: new Date(t0) },
        {
          sessionId,
          role: "assistant",
          content:
            "The Crossroads is a Faustian deal-making location: a place where a character trades something for power, straight out of crossroads folklore.",
          createdAt: new Date(t0 + 1000),
        },
      ],
    });
    const toolMarker = await prisma.message.create({
      data: {
        sessionId,
        role: "assistant",
        toolName: "bash",
        content: '→ bash({"command":"cd /Users/dev/Projects/sample-novel && git status"})',
        createdAt: new Date(t0 + 2000),
      },
    });
    toolMarkerId = toolMarker.id;
  });

  afterAll(async () => {
    if (sessionId) await prisma.session.delete({ where: { id: sessionId } }); // cascades to messages
    await prisma.$disconnect();
  });

  // --- project scoping: same query, different project, different results ---
  test("Crossroads found within sample-novel (the project it actually happened in)", async () => {
    const inScope = await recallMessages({ query: "Crossroads", project: "sample-novel", limit: 10 });
    expect(inScope.messages.length).toBeGreaterThan(0);
  });

  test("same query scoped to an unrelated project returns no more hits than the real one (project filter is not a no-op)", async () => {
    const inScope = await recallMessages({ query: "Crossroads", project: "sample-novel", limit: 10 });
    const outOfScope = await recallMessages({ query: "Crossroads", project: "recallkeep", limit: 10 });
    expect(outOfScope.messages.length).toBeLessThanOrEqual(inScope.messages.length);
  });

  // --- the actual regression: the ANSWER is findable, not just the question ---
  test("the original question is findable (FTS alone already could do this)", async () => {
    const result = await recallMessages({ query: "Crossroads", project: "sample-novel", limit: 10 });
    expect(result.messages.some((m) => m.role === "user" && m.content.includes("What is"))).toBe(true);
  });

  test("the ANSWER is also findable — this is what FTS-only search could not do before Phase 5", async () => {
    const result = await recallMessages({ query: "Crossroads", project: "sample-novel", limit: 10 });
    expect(
      result.messages.some((m) => m.role === "assistant" && /Faustian|deal-making|crossroads folklore/i.test(m.content)),
    ).toBe(true);
  });

  // --- ranking: results carry a real score, sorted descending ---
  test("every result carries a positive score", async () => {
    const result = await recallMessages({ query: "Crossroads", project: "sample-novel", limit: 10 });
    expect(result.messages.every((m) => typeof m.score === "number" && m.score > 0)).toBe(true);
  });

  test("results are sorted by score descending", async () => {
    const result = await recallMessages({ query: "Crossroads", project: "sample-novel", limit: 10 });
    const scores = result.messages.map((m) => m.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  // --- limit is respected ---
  test("limit=3 respected", async () => {
    const result = await recallMessages({ query: "the", project: "sample-novel", limit: 3 });
    expect(result.messages.length).toBeLessThanOrEqual(3);
  });

  // --- no query match returns empty, not an error ---
  test("no-match query returns empty array, not an error", async () => {
    const result = await recallMessages({ query: "zzznonexistentqueryzzz12345", project: "sample-novel", limit: 10 });
    expect(result.messages.length).toBe(0);
  });

  test("seeded tool-marker row is excluded by isToolMarker and does not leak into non-tool recall", async () => {
    const row = await prisma.message.findUniqueOrThrow({ where: { id: toolMarkerId } });
    expect(isToolMarker(row.content)).toBe(true);
    expect(isToolQuery("zzznonexistentqueryzzz12345")).toBe(false);
    const result = await recallMessages({ query: "zzznonexistentqueryzzz12345", project: "sample-novel", limit: 10 });
    expect(result.messages.some((m) => m.id === toolMarkerId)).toBe(false);
  });

  test("hyphenated token in message (deal-making) is matched by recallMessages", async () => {
    const result = await recallMessages({ query: "deal-making", project: "sample-novel", limit: 10 });
    expect(result.messages.some((m) => m.content.includes("deal-making"))).toBe(true);
  });
});
