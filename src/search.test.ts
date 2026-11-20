// Regression tests for BUG A (hyphenated & identifier-like tokens in FTS search).
// Pure unit tests for parseSearchQuery / escapeIlike run unconditionally;
// DB-backed tests against Postgres FTS + pg_trgm run when RECALLKEEP_TEST_DATABASE_URL is set.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const TEST_DB_URL = process.env.RECALLKEEP_TEST_DATABASE_URL;
if (TEST_DB_URL) {
  process.env.RECALLKEEP_DATABASE_URL = TEST_DB_URL;
  process.env.RECALLKEEP_LLM_PROVIDER = "none";
} else {
  delete process.env.RECALLKEEP_DATABASE_URL;
}

const { parseSearchQuery, escapeIlike } = await import("./recall.js");

describe("parseSearchQuery & escapeIlike (pure helpers)", () => {
  test("preserves hyphenated, underscored, and dotted identifier tokens", () => {
    for (const tok of ["MCP-LIVE-OK", "keep-live", "pg_trgm", "v0.1.0", "snake_case_name"]) {
      const parsed = parseSearchQuery(tok);
      expect(parsed.tokens).toEqual([tok]);
      expect(parsed.identifierTokens).toEqual([tok]);
      expect(parsed.webAndQuery).toBe(tok);
      expect(parsed.webOrQuery).toBe(tok);
    }
  });

  test("strips surrounding brackets and punctuation without collapsing internal delimiters", () => {
    const parsed = parseSearchQuery("[keep-live] MCP-LIVE-OK codex");
    expect(parsed.tokens).toEqual(["keep-live", "MCP-LIVE-OK", "codex"]);
    expect(parsed.identifierTokens).toEqual(["keep-live", "MCP-LIVE-OK"]);
    expect(parsed.webAndQuery).toBe("keep-live MCP-LIVE-OK codex");
    expect(parsed.webOrQuery).toBe("keep-live OR MCP-LIVE-OK OR codex");
  });

  test("ordinary word queries produce no identifier fallback tokens", () => {
    const parsed = parseSearchQuery("What is The Crossroads?");
    expect(parsed.tokens).toEqual(["What", "is", "The", "Crossroads"]);
    expect(parsed.identifierTokens).toEqual([]);
    expect(parsed.webOrQuery).toBe("What OR is OR The OR Crossroads");
  });

  test("escapeIlike escapes SQL wildcard characters", () => {
    expect(escapeIlike("pg_trgm")).toBe("pg\\_trgm");
    expect(escapeIlike("100%_done\\ok")).toBe("100\\%\\_done\\\\ok");
  });
});

describe.skipIf(!TEST_DB_URL)("textSearch & recall hyphenated/identifier tokens (needs RECALLKEEP_TEST_DATABASE_URL)", () => {
  let textSearch: typeof import("./recall.js").textSearch;
  let recall: typeof import("./recall.js").recall;
  let recallMessages: typeof import("./recall.js").recallMessages;
  let prisma: typeof import("./client.js").prisma;
  let sessionId: string;
  let factIds: string[] = [];

  const FIXTURE_CONTENT =
    "[keep-live] MCP-LIVE-OK codex verified with pg_trgm on release v0.1.0 using snake_case_name";

  beforeAll(async () => {
    ({ textSearch, recall, recallMessages } = await import("./recall.js"));
    ({ prisma } = await import("./client.js"));

    const fact = await prisma.memoryFact.create({
      data: {
        category: "FACT",
        tier: "LONG_TERM",
        content: FIXTURE_CONTENT,
        tags: ["project:keep-live-test"],
      },
    });
    factIds.push(fact.id);

    const session = await prisma.session.create({
      data: {
        channel: "pi",
        title: "search.test fixture",
        metadata: { project: "keep-live-test" },
      },
    });
    sessionId = session.id;

    await prisma.message.create({
      data: {
        sessionId,
        role: "assistant",
        content: FIXTURE_CONTENT,
      },
    });
  });

  afterAll(async () => {
    if (factIds.length > 0) {
      await prisma.memoryFact.deleteMany({ where: { id: { in: factIds } } });
    }
    if (sessionId) {
      await prisma.session.delete({ where: { id: sessionId } });
    }
    await prisma.$disconnect();
  });

  for (const token of ["MCP-LIVE-OK", "keep-live", "pg_trgm", "v0.1.0", "snake_case_name"]) {
    test(`textSearch finds fact and message for identifier token "${token}"`, async () => {
      const res = await textSearch({ query: token, tables: ["facts", "messages"], limit: 20 });
      expect(res.facts.some((f) => f.id === factIds[0])).toBe(true);
      expect(res.messages.some((m) => m.sessionId === sessionId)).toBe(true);
    });

    test(`recall and recallMessages find fact and message for identifier token "${token}"`, async () => {
      const factRes = await recall({ query: token, tags: ["project:keep-live-test"], limit: 10 });
      expect(factRes.facts.some((f) => f.id === factIds[0])).toBe(true);

      const msgRes = await recallMessages({ query: token, project: "keep-live-test", limit: 10 });
      expect(msgRes.messages.some((m) => m.sessionId === sessionId)).toBe(true);
    });
  }

  test("ordinary word query still matches fact and message without breaking", async () => {
    const res = await textSearch({ query: "codex verified", tables: ["facts", "messages"], limit: 20 });
    expect(res.facts.some((f) => f.id === factIds[0])).toBe(true);
    expect(res.messages.some((m) => m.sessionId === sessionId)).toBe(true);
  });

  test("non-matching identifier token returns neither fixture fact nor message", async () => {
    const res = await textSearch({ query: "MCP-DEAD-NOPE-999", tables: ["facts", "messages"], limit: 20 });
    expect(res.facts.some((f) => f.id === factIds[0])).toBe(false);
    expect(res.messages.some((m) => m.sessionId === sessionId)).toBe(false);
  });
});
