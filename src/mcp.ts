/**
 * MCP server over stdio. Any MCP client (Claude Code, Codex CLI, Antigravity
 * CLI, pi, Cursor, ...) starts it as a child process:
 *
 *   bun /path/to/ira-memory/src/cli.ts mcp
 *
 * It is a thin layer over the HTTP API (IRA_URL, default http://127.0.0.1:7775),
 * so the API server must be running. The project defaults to the one derived
 * from the directory the client started the server in.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BASE_URL,
  FACT_TYPES,
  SEARCH_RESULT_LIMIT,
  forgetFact,
  listFacts,
  projectFor,
  request,
  saveFact,
  searchMemory,
  sessionContext,
} from "./agent-memory.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const cwd = () => process.env.IRA_CWD ?? process.cwd();
const DOWN = `ira-memory is not reachable at ${BASE_URL}. Start it with \`bun run memory-api\`.`;

export async function runMcpServer(): Promise<void> {
  const { version } = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const server = new McpServer({ name: "ira-memory", version });

  server.registerTool(
    "memory_search",
    {
      description: [
        "Search ira-memory: curated facts and full prior session history (user and assistant turns, tool activity).",
        "Use it before asking the user to repeat something or re-deciding something an earlier session settled.",
        'Defaults to the current project. Pass project:"all" to search every project, or another slug.',
        "History results are truncated previews: pass expandId (from a result's [id=...]) to read one in full.",
      ].join(" "),
      inputSchema: {
        query: z.string().optional().describe("Search text. Omit when using expandId."),
        expandId: z.string().optional().describe("A history result id to read in full."),
        project: z.string().optional().describe('Project slug, or "all". Defaults to the current project.'),
        limit: z.number().int().positive().max(50).optional().describe(`Max results (default ${SEARCH_RESULT_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => text(await searchMemory({ ...args, cwd: cwd() })),
  );

  server.registerTool(
    "memory_save",
    {
      description: [
        "Save a curated fact to ira-memory so later sessions know it: decisions, the user's rules and preferences,",
        "findings, what was verified and how, status, open questions. One idea per fact, self-contained, dated, with the why.",
        'Defaults to the current project. project:"global" saves a standing rule shown at the start of every session.',
        'Add the tag "decision" to a settled decision so it is shown at the start of this project\'s sessions.',
      ].join(" "),
      inputSchema: {
        content: z.string().min(1).describe("The fact: what, why, date, and how it was verified."),
        type: z
          .enum(FACT_TYPES)
          .optional()
          .describe("user = preference or rule, feedback = lesson, project = project state (default), reference = context."),
        project: z.string().optional().describe('Project slug. Defaults to the current project. "global" for rules.'),
        tags: z.array(z.string()).optional().describe('Extra tags, e.g. ["decision"].'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const fact = await saveFact({ ...args, cwd: cwd() });
      if (!fact) return { ...text(`Nothing was saved. ${DOWN} (or no project could be derived: pass project).`), isError: true };
      return text(`Saved [fact id=${fact.id}] ${fact.tags.join(",")}\n${fact.content}`);
    },
  );

  server.registerTool(
    "memory_context",
    {
      description:
        "The standing rules, locked decisions and recent facts for the current project: the same block hooks inject at session start. Call it at the start of a task if your client has no session-start hook.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text((await sessionContext(cwd())) || `No stored context for project ${projectFor(cwd()) ?? "(none)"}.`),
  );

  server.registerTool(
    "memory_list",
    {
      description: "List the newest facts for a project, with ids. Use it to find a fact to forget.",
      inputSchema: {
        project: z.string().optional().describe('Project slug. Defaults to the current project. "global" for rules.'),
        limit: z.number().int().positive().max(200).optional().describe("Max facts (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, limit }) => {
      const slug = project ?? projectFor(cwd());
      if (!slug) return text("No project could be derived from the working directory. Pass project.");
      const facts = await listFacts(slug, limit ?? 20);
      if (!facts.length) return text(`No facts for project ${slug} (or ${DOWN.toLowerCase()})`);
      return text(facts.map((f) => `[fact id=${f.id}] ${f.created_at.slice(0, 10)} ${f.tags.join(",")}\n${f.content}`).join("\n\n"));
    },
  );

  server.registerTool(
    "memory_forget",
    {
      description: "Archive one fact by id so recall stops returning it. Archived facts are kept, not deleted.",
      inputSchema: { id: z.string().min(1).describe("Fact id from memory_search or memory_list.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => ((await forgetFact(id)) ? text(`Archived fact ${id}.`) : { ...text(`Could not archive ${id}. ${DOWN}`), isError: true }),
  );

  await server.connect(new StdioServerTransport());
  // Warn once on stderr (never stdout: that is the protocol channel) if the API is down.
  if (!(await request("/health"))) console.error(`[ira-memory mcp] ${DOWN}`);
}
