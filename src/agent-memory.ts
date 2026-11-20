/**
 * Agent-facing memory operations, shared by the MCP server (mcp.ts) and the
 * lifecycle hooks (hook.ts). Talks to the HTTP API rather than Postgres, so
 * every agent sees exactly what the pi extension and the CLI see, and one
 * server owns the database.
 *
 * Every call fails open: a timeout, a network error or a non-2xx returns
 * null or [], never a thrown error. Memory being down must not break an agent.
 *
 * The formatting and budgets mirror integrations/pi/index.ts so an agent gets
 * the same session-start context in every harness.
 */

import { redactSecrets } from "./redact.js";
import { deriveProjectSlug } from "./slug.js";

export const BASE_URL = (process.env.IRA_URL ?? `http://127.0.0.1:${process.env.MEMORY_API_PORT ?? 7775}`).replace(/\/+$/, "");
const TOKEN = process.env.IRA_API_TOKEN ?? "";
const TIMEOUT_MS = Number(process.env.IRA_CLIENT_TIMEOUT_MS ?? 2000);

export const GLOBAL_SLUG = "global";
export const FACT_TYPES = ["user", "feedback", "project", "reference"] as const;
export type FactType = (typeof FACT_TYPES)[number];

export interface Fact {
  id: string;
  content: string;
  tags: string[];
  created_at: string;
  score?: number;
}
export interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
  score?: number;
}

/** Auto-generated digests written every session. Noise for an agent. */
const BOOKKEEPING_TAGS = new Set(["session-summary", "pi:session-topic"]);
const isBookkeeping = (f: Fact) => (f.tags ?? []).some((t) => BOOKKEEPING_TAGS.has(t));

export async function request<T>(path: string, init: RequestInit = {}, cwd?: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    if (cwd) headers["X-Cwd"] = cwd;
    const res = await fetch(BASE_URL + path, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const q = encodeURIComponent;

export function projectFor(cwd: string | undefined): string | null {
  return deriveProjectSlug(cwd ?? null);
}

export async function listFacts(project: string, limit: number): Promise<Fact[]> {
  const r = await request<{ facts: Fact[] }>(`/memory/list?project=${q(project)}&limit=${limit}`);
  return r?.facts ?? [];
}

// ─── Search ─────────────────────────────────────────────────────

export const SEARCH_RESULT_LIMIT = 8;
const SEARCH_PREVIEW_CHARS = 300;

function merge(lists: Fact[][], limit: number): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const f of lists.flat()) {
    if (isBookkeeping(f) || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

async function searchOnce(query: string, scope: string, limit: number) {
  const scoped = scope === "all" ? "" : `&project=${q(scope)}`;
  const [keyword, semantic, history] = await Promise.all([
    request<{ facts: Fact[] }>(`/memory/search?q=${q(query)}${scoped}&limit=${limit}`),
    // Semantic recall is unscoped, like the pi tool: it catches facts phrased differently.
    request<{ facts: Fact[] }>(`/memory/recall?topic=${q(query)}&limit=${limit * 5}`),
    request<{ messages: Message[] }>(`/conversation/recall?q=${q(query)}${scoped}&limit=${limit}`),
  ]);
  return {
    facts: merge([semantic?.facts ?? [], keyword?.facts ?? []], limit),
    messages: history?.messages ?? [],
  };
}

/** Facts (keyword + semantic) and session history, as text an agent can read. */
export async function searchMemory(opts: {
  query?: string;
  expandId?: string;
  project?: string;
  limit?: number;
  cwd?: string;
}): Promise<string> {
  if (opts.expandId) {
    const m = await request<Message>(`/conversation/message/${q(opts.expandId)}`);
    if (!m) return `No message found with id "${opts.expandId}" (service may be down, or the id was mistyped).`;
    return `[id=${m.id}] [${m.role}] ${m.created_at}\n\n${m.content}`;
  }
  if (!opts.query) return "Provide either query (to search) or expandId (to read one result in full).";

  const scope = opts.project ?? projectFor(opts.cwd) ?? "all";
  const limit = opts.limit ?? SEARCH_RESULT_LIMIT;
  let { facts, messages } = await searchOnce(opts.query, scope, limit);
  let widened = false;
  if (!facts.length && !messages.length && scope !== "all") {
    widened = true;
    ({ facts, messages } = await searchOnce(opts.query, "all", limit));
  }
  if (!facts.length && !messages.length) {
    const where = scope === "all" ? "every project" : widened ? `project ${scope}, then every project` : `project ${scope}`;
    return (
      `Searched facts and session history in ${where} for "${opts.query}": no match. ` +
      `This means the query did not match, not that memory is empty. Try other wording.`
    );
  }
  const sections: string[] = [];
  if (facts.length) {
    sections.push(`## Facts\n\n${facts.map((f) => `[fact id=${f.id}] ${f.tags.join(",")}\n${f.content}`).join("\n\n---\n\n")}`);
  }
  if (messages.length) {
    const lines = messages.map((m) => {
      const preview = m.content.length > SEARCH_PREVIEW_CHARS ? `${m.content.slice(0, SEARCH_PREVIEW_CHARS)}…` : m.content;
      const score = typeof m.score === "number" ? ` (score ${m.score.toFixed(2)})` : "";
      return `[id=${m.id}] [${m.role}] ${m.created_at}${score}\n${preview}`;
    });
    sections.push(`## History\n\n${lines.join("\n\n---\n\n")}`);
  }
  return `${sections.join("\n\n")}\n\n(Search again with expandId set to any history [id] for its full text.)`;
}

// ─── Save / forget / list ───────────────────────────────────────

export async function saveFact(opts: {
  content: string;
  type?: FactType;
  project?: string;
  tags?: string[];
  cwd?: string;
}): Promise<Fact | null> {
  const project = opts.project ?? projectFor(opts.cwd);
  if (!project || !opts.content.trim()) return null;
  return request<Fact>("/memory", {
    method: "POST",
    body: JSON.stringify({
      content: opts.content,
      type: opts.type ?? (project === GLOBAL_SLUG ? "user" : "project"),
      project,
      ...(opts.tags?.length ? { tags: opts.tags } : {}),
    }),
  });
}

export async function forgetFact(id: string): Promise<boolean> {
  const r = await request<{ archived: boolean }>(`/memory/${q(id)}`, { method: "DELETE" });
  return r?.archived === true;
}

// ─── Session-start context ──────────────────────────────────────

const RULES_FETCH = 100;
const RULES_CHAR_BUDGET = 2000;
const DECISION_FETCH = 200;
const DECISIONS_CHAR_BUDGET = 2000;
const RECENT_FETCH = 200;
const RECENT_LIMIT = 8;
const RECENT_CHAR_BUDGET = 1600;
const RECENT_PREVIEW_CHARS = 200;
const NOT_RULES = new Set(["pi:handoff", ...BOOKKEEPING_TAGS]);

function capped(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > budget) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/** Standing rules (project "global"), oldest first, whole facts only. */
export function formatRules(facts: Fact[]): string {
  const lines = capped(
    facts
      .filter((f) => !(f.tags ?? []).some((t) => NOT_RULES.has(t)))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((f) => `- ${f.content.trim().replace(/^\[global\]\s*/, "")}`),
    RULES_CHAR_BUDGET,
  );
  return lines.length ? `## Standing rules (ira-memory, every project)\n${lines.join("\n")}\n` : "";
}

/** Facts tagged "decision", newest first. */
export function formatDecisions(facts: Fact[]): string {
  const lines = capped(
    facts
      .filter((f) => (f.tags ?? []).includes("decision"))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((f) => `- ${f.content}`),
    DECISIONS_CHAR_BUDGET,
  );
  return lines.length ? `## Locked decisions for this project\n${lines.join("\n")}\n` : "";
}

/** Newest substantive facts, excluding decisions, handoffs and digests. */
export function formatRecent(facts: Fact[]): string {
  const notable = facts.filter((f) => {
    const tags = f.tags ?? [];
    return !tags.includes("pi:handoff") && !tags.includes("decision") && !tags.some((t) => BOOKKEEPING_TAGS.has(t));
  });
  const lines = capped(
    notable.slice(0, RECENT_LIMIT).map((f) => {
      const c = f.content.trim();
      const preview = c.length > RECENT_PREVIEW_CHARS ? `${c.slice(0, RECENT_PREVIEW_CHARS)}…` : c;
      return `- (${f.created_at.slice(0, 10)}) ${preview}`;
    }),
    RECENT_CHAR_BUDGET,
  );
  return lines.length ? `## Recent facts for this project\n${lines.join("\n")}\n` : "";
}

/** Rules + decisions + recent facts for the project at `cwd`. "" when there is nothing. */
export async function sessionContext(cwd: string | undefined): Promise<string> {
  const project = projectFor(cwd);
  const [rules, projectFacts] = await Promise.all([
    listFacts(GLOBAL_SLUG, RULES_FETCH),
    project ? listFacts(project, Math.max(DECISION_FETCH, RECENT_FETCH)) : Promise.resolve([]),
  ]);
  const body = [formatRules(rules), formatDecisions(projectFacts), formatRecent(projectFacts)].filter(Boolean).join("\n");
  if (!body) return "";
  return (
    `# ira-memory${project ? ` (project: ${project})` : ""}\n\n${body}\n` +
    `Use the memory_search tool before re-deciding anything, and memory_save to record decisions and findings.\n`
  );
}

// ─── Prompt-time recall ─────────────────────────────────────────

// Same shape as the Claude Code hook this replaces: over-fetch 15 so the
// server's cwd project boost has candidates to re-rank, show the best 5.
const PROMPT_RECALL_FETCH = 15;
const PROMPT_RECALL_LIMIT = 5;
const PROMPT_RECALL_PREVIEW_CHARS = 220;

/** Facts relevant to the user's prompt, boosted toward the cwd's project. "" for trivial prompts. */
export async function promptContext(prompt: string, cwd: string | undefined): Promise<string> {
  const p = prompt.trim();
  if (p.length < 8 || p.startsWith("<")) return ""; // trivial or system text
  const r = await request<{ facts: Fact[] }>(
    `/memory/recall?topic=${q(p.slice(0, 2000))}&limit=${PROMPT_RECALL_FETCH}`,
    {},
    cwd,
  );
  const lines = (r?.facts ?? [])
    .filter((f) => !isBookkeeping(f))
    .slice(0, PROMPT_RECALL_LIMIT)
    .map((f) => `- ${f.content.replace(/\s+/g, " ").trim().slice(0, PROMPT_RECALL_PREVIEW_CHARS)}`);
  return lines.length ? `## Related memory (ira-memory)\n${lines.join("\n")}\n` : "";
}

// ─── Turn capture ───────────────────────────────────────────────

/**
 * Append one turn message to the harness session's conversation log. Secrets
 * are redacted first, the same chain pi transcript capture uses.
 */
export async function logTurn(opts: {
  harness: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  cwd?: string;
}): Promise<boolean> {
  if (!opts.content.trim()) return false;
  const { content } = await redactSecrets(opts.content);
  const r = await request<{ id: string }>("/conversation/log", {
    method: "POST",
    body: JSON.stringify({
      channel: `${opts.harness}:${opts.sessionId}`,
      role: opts.role,
      content,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }),
  });
  return !!r;
}
