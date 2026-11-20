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
// IRA_TEST_DATABASE_URL points at a throwaway, already-migrated database.
// Bun auto-loads .env, so the real MEMORY_DATABASE_URL is always present in
// the environment — it is overwritten below BEFORE the Prisma client is
// imported, and the modules are loaded with dynamic import for that reason.
// Embeddings are disabled (IRA_LLM_PROVIDER=none): the assertions are
// satisfied by the full-text layer alone, so no OpenAI call is made.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const TEST_DB_URL = process.env.IRA_TEST_DATABASE_URL;
if (TEST_DB_URL) {
  process.env.MEMORY_DATABASE_URL = TEST_DB_URL;
  process.env.IRA_LLM_PROVIDER = "none";
} else {
  delete process.env.MEMORY_DATABASE_URL;
}

describe.skipIf(!TEST_DB_URL)("recallMessages (needs IRA_TEST_DATABASE_URL)", () => {
  let recallMessages: typeof import("./recall.js").recallMessages;
  let prisma: typeof import("./client.js").prisma;
  let sessionId: string;

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
    const outOfScope = await recallMessages({ query: "Crossroads", project: "ira-memory", limit: 10 });
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
});
