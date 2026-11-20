/**
 * Typed HTTP client for ira-memory.
 *
 * Every function here fails open: a timeout, a network error, a non-2xx
 * response, or a malformed JSON body all resolve to `null` (or `[]` for the
 * list/array-returning calls) — never a thrown exception. This follows
 * a core design rule: memory being down must never delay, block, or fail
 * a session. Every request carries `AbortSignal.timeout(800)`.
 *
 * Endpoint contract: `./API.md`.
 *
 * Naming note for callers: `listFacts` takes the *raw* project
 * slug (e.g. `"ira-memory"`), matching the server's `?project=` query param,
 * which it internally expands to the tag `project:<slug>`. `writeHandoff`
 * instead takes the *full* tag string (e.g. `"project:ira-memory"|"project:Projects"`)
 * as produced by `projectTagForCwd`, because it is written verbatim into the
 * fact's tags rather than through the server's project-resolution field.
 */

const BASE_URL = (process.env.IRA_URL ?? "http://127.0.0.1:7775").replace(/\/+$/, "");
const TIMEOUT_MS = 800;

export interface Fact {
	id: string;
	name: string | null;
	type: string | null;
	description: string | null;
	content: string;
	category: string;
	tier: string;
	tags: string[];
	created_at: string;
	score?: number;
}

export interface Message {
	id: string;
	role: string;
	content: string;
	channel: string | null;
	created_at: string;
}

export interface SyncSessionResult {
	accepted: boolean;
}

export interface HealthResult {
	status: string;
	backend: string;
	port: number;
}

async function request<T>(
	path: string,
	init: RequestInit,
): Promise<T | null> {
	try {
		// Read per call so a token set after import (or in tests) is honoured.
		const token = process.env.IRA_API_TOKEN;
		const res = await fetch(`${BASE_URL}${path}`, {
			...init,
			headers: token ? { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } : init.headers,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

/**
 * Tell ira-memory to (re-)import a pi session's transcript from disk.
 * `POST /session/sync`. Carries a file path only, never message content —
 * the server reads `sessionFile` itself. Idempotent: safe to
 * call repeatedly against the same growing file.
 *
 * `final: true` on `session_shutdown` marks the imported session ended.
 * Returns `null` on any failure (down, timeout, non-2xx, bad JSON) — the
 * caller uses that to drive a circuit breaker (see index.ts), since this is
 * the only network call the extension makes on every settled turn.
 */
export async function syncSession(
	sessionFile: string,
	sessionId: string,
	cwd: string,
	final = false,
): Promise<SyncSessionResult | null> {
	return request<SyncSessionResult>("/session/sync", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionFile, sessionId, cwd, final }),
	});
}

/**
 * Store the session handoff as a fact tagged with both `projectTag`
 * (e.g. `"project:ira-memory"`) and `"pi:handoff"`. `POST /memory`.
 * Returns `null` on any failure.
 */
export async function writeHandoff(
	projectTag: string,
	content: string,
): Promise<Fact | null> {
	return request<Fact>("/memory", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			content,
			type: "project",
			tags: [projectTag, "pi:handoff"],
		}),
	});
}

/** Fact types accepted by `POST /memory` (API.md): user→PREFERENCE, feedback→LESSON, project→PROJECT_STATE, reference→CONTEXT. */
export const FACT_TYPES = ["user", "feedback", "project", "reference"] as const;
export type FactType = (typeof FACT_TYPES)[number];

export interface SaveFactInput {
	content: string;
	type: FactType;
	/** Raw slug. The server adds the `project:<slug>` tag and a `[slug]` content prefix. */
	project: string;
	tags?: string[];
	name?: string;
}

/**
 * Store one curated fact. `POST /memory`. Unlike `writeHandoff` the project
 * goes through the server's `project` field, so the tag and content prefix
 * are the server's own. Returns `null` on any failure.
 */
export async function saveFact(input: SaveFactInput): Promise<Fact | null> {
	return request<Fact>("/memory", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			content: input.content,
			type: input.type,
			project: input.project,
			tags: input.tags ?? [],
			...(input.name ? { name: input.name } : {}),
		}),
	});
}

/**
 * List stored facts for a project. `projectSlug` is the raw slug (no
 * `project:` prefix) — the server expands it to the `project:<slug>` tag
 * filter itself. `GET /memory/list`. Returns `[]` on any failure.
 */
export async function listFacts(
	projectSlug: string,
	limit: number,
): Promise<Fact[]> {
	const url = `/memory/list?project=${encodeURIComponent(projectSlug)}&limit=${encodeURIComponent(String(limit))}`;
	const result = await request<{ facts: Fact[]; total: number }>(url, {
		method: "GET",
	});
	return result?.facts ?? [];
}

/**
 * Full-text search over curated facts (`memory_facts`), not raw conversation
 * history. `GET /memory/search`. `project` omitted or "all" searches every
 * project's facts; otherwise scoped to that one slug. Returns `[]` on any failure.
 */
export async function searchFacts(
	query: string,
	project: string | undefined,
	limit: number,
): Promise<Fact[]> {
	const scoped = project && project !== "all" ? `&project=${encodeURIComponent(project)}` : "";
	const url = `/memory/search?q=${encodeURIComponent(query)}${scoped}&limit=${encodeURIComponent(String(limit))}`;
	const result = await request<{ facts: Fact[] }>(url, { method: "GET" });
	return result?.facts ?? [];
}

/**
 * Hybrid keyword + semantic search over curated facts (`memory_facts`).
 * `GET /memory/recall`. Returns `[]` on any failure.
 *
 * This is the semantic counterpart to `searchFacts`, which is full-text only.
 * Measured on a real store:
 *   /memory/search?q="what shirt brand do we use"  → 0 hits
 *   /memory/recall?topic="apple watch ultra action button" → the watch fact, score 0.82
 *
 * PARAM NAME: the server reads `topic`, not `q` (`src/http-server.ts`). A caller
 * sending `?q=` gets it silently ignored — `query` arrives undefined and the
 * endpoint degrades to topic-less recency ranking, returning the same newest
 * facts for every query. This exact bug hid the whole recall path for a long time.
 *
 * Deliberately unscoped: the endpoint ranks across every project, and a fact
 * filed under another slug is still the right answer. Callers scope after the
 * fact if they need to.
 */
export async function recallFacts(query: string, limit: number): Promise<Fact[]> {
	const url = `/memory/recall?topic=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`;
	const result = await request<{ facts: Fact[] }>(url, { method: "GET" });
	return result?.facts ?? [];
}

/**
 * Fetch recent messages for a channel. `GET /conversation/recent`.
 * Returns `[]` on any failure.
 */
export async function recentMessages(
	channel: string,
	limit: number,
): Promise<Message[]> {
	const url = `/conversation/recent?channel=${encodeURIComponent(channel)}&limit=${encodeURIComponent(String(limit))}`;
	const result = await request<{ messages: Message[] }>(url, {
		method: "GET",
	});
	return result?.messages ?? [];
}

export interface RankedMessage extends Message {
	score: number;
}

/**
 * Hybrid FTS + semantic search over full message history for this project.
 * `GET /conversation/recall`. Backs the `memory_search` tool.
 * Returns `[]` on any failure.
 */
export async function recallHistory(
	query: string,
	project: string | undefined,
	limit: number,
): Promise<RankedMessage[]> {
	const scoped = project && project !== "all" ? `&project=${encodeURIComponent(project)}` : "";
	const url = `/conversation/recall?q=${encodeURIComponent(query)}${scoped}&limit=${encodeURIComponent(String(limit))}`;
	const result = await request<{ messages: RankedMessage[] }>(url, { method: "GET" });
	return result?.messages ?? [];
}

/**
 * Fetch one message in full by id — the "expand" half of memory_search's
 * truncated-matches-then-expand(id) design. `GET /conversation/message/:id`.
 * Returns `null` on any failure (including a genuine 404).
 */
export async function getMessage(id: string): Promise<Message | null> {
	return request<Message>(`/conversation/message/${encodeURIComponent(id)}`, { method: "GET" });
}

/**
 * Check whether the ira-memory service is up. `GET /health`.
 * Returns `null` on any failure.
 */
export async function health(): Promise<HealthResult | null> {
	return request<HealthResult>("/health", { method: "GET" });
}
