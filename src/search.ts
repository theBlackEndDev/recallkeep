import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { generateEmbedding } from "./embed.js";
import type { MemoryFact, Message, Summary } from "./types.js";

/**
 * True when a message's content is a pi-capture tool-call marker (`→ toolName(...)`).
 * Tool calls are stored as short marker rows for FTS lookup, not prose; in vector space
 * they cluster near 0.30–0.33 cosine similarity against arbitrary/gibberish queries.
 */
export function isToolMarker(content: string): boolean {
  return /^\s*→\s+\S+\(/.test(content);
}

/**
 * True when the search query itself is asking for a tool call (starts with `→` or
 * names a tool invocation like `bash(` / `tool call`).
 */
export function isToolQuery(query: string): boolean {
  return /^\s*→|\btool[\s_-]*call\b|\b[a-z_][a-z0-9_]*\s*\(/i.test(query);
}

export interface SemanticSearchInput {
  query: string;
  tables?: Array<"facts" | "summaries" | "messages">;
  limit?: number;
  threshold?: number;
  channel?: string;
}

export interface SemanticSearchResult {
  facts: Array<MemoryFact & { similarity: number }>;
  summaries: Array<Summary & { similarity: number }>;
  messages: Array<Message & { similarity: number }>;
}

/**
 * Semantic search using pgvector cosine similarity.
 * Embeds the query, then searches across fact/summary/message embedding tables.
 */
export async function semanticSearch(
  input: SemanticSearchInput
): Promise<SemanticSearchResult> {
  const limit = input.limit ?? 10;
  const threshold = input.threshold ?? 0.3;
  const tables = input.tables ?? ["facts", "summaries"];

  const result: SemanticSearchResult = { facts: [], summaries: [], messages: [] };

  const queryVector = await generateEmbedding(input.query);
  if (!queryVector.length) return result; // embeddings disabled — recall falls back to FTS + structured
  const vectorStr = `[${queryVector.join(",")}]`;

  if (tables.includes("facts")) {
    const rawFacts = await prisma.$queryRaw<
      Array<{ fact_id: string; similarity: number }>
    >`
      -- Chunked embeddings mean one parent can have many rows. Collapse to the best-matching
      -- chunk per parent, or a single long document would occupy every slot in the result with
      -- its own fragments and crowd out everything else.
      -- Inner query keeps the ORDER BY <=> ... LIMIT shape so the HNSW index stays usable;
      -- over-fetching gives the outer GROUP BY enough rows to still fill the limit after collapsing.
      SELECT fact_id, MAX(similarity) AS similarity
      FROM (
        SELECT fe.fact_id, 1 - (fe.vector <=> ${vectorStr}::vector) AS similarity
        FROM fact_embeddings fe
        JOIN memory_facts mf ON mf.id = fe.fact_id
        WHERE mf.is_archived = false
        ORDER BY fe.vector <=> ${vectorStr}::vector
        LIMIT ${limit * 4}
      ) t
      WHERE similarity > ${threshold}
      GROUP BY fact_id
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    if (rawFacts.length > 0) {
      const facts = await prisma.memoryFact.findMany({
        where: { id: { in: rawFacts.map((r) => r.fact_id) } },
      });
      const simMap = new Map(rawFacts.map((r) => [r.fact_id, r.similarity]));
      result.facts = facts
        .map((f) => ({ ...f, similarity: simMap.get(f.id) ?? 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    }
  }

  if (tables.includes("summaries")) {
    const rawSummaries = await prisma.$queryRaw<
      Array<{ summary_id: string; similarity: number }>
    >`
      SELECT summary_id, MAX(similarity) AS similarity
      FROM (
        SELECT se.summary_id, 1 - (se.vector <=> ${vectorStr}::vector) AS similarity
        FROM summary_embeddings se
        ORDER BY se.vector <=> ${vectorStr}::vector
        LIMIT ${limit * 4}
      ) t
      WHERE similarity > ${threshold}
      GROUP BY summary_id
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;

    if (rawSummaries.length > 0) {
      const summaries = await prisma.summary.findMany({
        where: { id: { in: rawSummaries.map((r) => r.summary_id) } },
      });
      const simMap = new Map(rawSummaries.map((r) => [r.summary_id, r.similarity]));
      result.summaries = summaries
        .map((s) => ({ ...s, similarity: simMap.get(s.id) ?? 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    }
  }

  if (tables.includes("messages")) {
    let rawMessages: Array<{ message_id: string; similarity: number }>;
    const toolFilter = isToolQuery(input.query)
      ? Prisma.empty
      : Prisma.sql`AND m.content NOT LIKE '→ %'`;

    if (input.channel) {
      rawMessages = await prisma.$queryRaw`
        -- Collapse chunk rows to the best chunk per message (see the facts query above).
        SELECT message_id, MAX(similarity) AS similarity
        FROM (
          SELECT me.message_id, 1 - (me.vector <=> ${vectorStr}::vector) AS similarity
          FROM message_embeddings me
          JOIN messages m ON m.id = me.message_id
          JOIN sessions s ON s.id = m.session_id
          WHERE s.channel = ${input.channel} ${toolFilter}
          ORDER BY me.vector <=> ${vectorStr}::vector
          LIMIT ${limit * 4}
        ) t
        WHERE similarity > ${threshold}
        GROUP BY message_id
        ORDER BY similarity DESC
        LIMIT ${limit}
      `;
    } else {
      rawMessages = await prisma.$queryRaw`
        SELECT message_id, MAX(similarity) AS similarity
        FROM (
          SELECT me.message_id, 1 - (me.vector <=> ${vectorStr}::vector) AS similarity
          FROM message_embeddings me
          JOIN messages m ON m.id = me.message_id
          WHERE 1=1 ${toolFilter}
          ORDER BY me.vector <=> ${vectorStr}::vector
          LIMIT ${limit * 4}
        ) t
        WHERE similarity > ${threshold}
        GROUP BY message_id
        ORDER BY similarity DESC
        LIMIT ${limit}
      `;
    }

    if (rawMessages.length > 0) {
      const messages = await prisma.message.findMany({
        where: { id: { in: rawMessages.map((r) => r.message_id) } },
      });
      const simMap = new Map(rawMessages.map((r) => [r.message_id, r.similarity]));
      result.messages = messages
        .map((m) => ({ ...m, similarity: simMap.get(m.id) ?? 0 }))
        .sort((a, b) => b.similarity - a.similarity);
    }
  }

  return result;
}
