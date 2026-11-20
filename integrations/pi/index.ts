/**
 * Session memory extension: connects pi to ira-memory.
 *
 * Why capture works the way it does: the original design journaled a one-line, 500-char
 * digest of each turn — user request truncated to 120 chars, tool names,
 * file paths — and sent THAT to ira-memory as the sole record, mislabeled
 * `role: "assistant"` even though it was mostly the user's own text. The
 * model's actual answer was never stored. In one real case that lost an
 * afternoon of design decisions: the reasoning existed only in the session
 * transcript, and the journal line for the turn that contained it was 94
 * characters of the user's question. pi already
 * writes a complete, durable transcript to `~/.pi/agent/sessions/**\/*.jsonl`
 * on every turn — this file's job became mirroring that, not re-capturing it.
 *
 *   session_start      → read the last handoff (or recent chatter) for this
 *                         project, append it to the transcript as a custom
 *                         entry, hold it for injection.
 *
 * That entry is deliberately NOT `ctx.ui.notify(text, "info")`. `notify` of
 * type "info" routes to `showStatus`, which de-duplicates by mutating the
 * previous status line in place whenever its node is still last in the chat
 * container (interactive-mode.js:2878-2892). At startup ours is always last,
 * so the next status message — a startup diagnostic, or "Startup is still in
 * progress" if the user types early — overwrote the handoff silently. Worse,
 * notify output is not a session entry, so any later rebind (/resume, /fork,
 * /new) discards it permanently. A custom entry survives both: it is appended,
 * never de-duplicated, and replayed from the session file.
 *   before_agent_start  → inject that same text into the system prompt under
 *                         "## Previous session", once per session.
 *   agent_settled       → (a) build the LOCAL turn digest used only for the
 *                         eventual handoff (journal.ts — this never leaves
 *                         the process), and (b) debounce-schedule a sync of
 *                         pi's own session FILE to ira-memory. No message
 *                         content crosses the network from this file at all;
 *                         `POST /session/sync` carries a path, and ira-memory
 *                         reads the transcript itself. That is what makes the
 *                         truncation failure mode structurally impossible to
 *                         reintroduce here — there is no string in this file
 *                         for a future truncation constant to clip.
 *
 * "Keep it" (the local digest) cannot mean a variable. `/reload` re-evaluates
 * this module from disk, so every closure and module-level binding starts
 * over — a reload mid-session used to reset the journal to empty, and the
 * handoff written at quit then covered only the turns after the last reload.
 * Each digest is therefore also appended as a `journal-line` custom entry and
 * the journal is rebuilt from those at session_start. Custom entries persist
 * in the session file, are scoped to exactly one session, and are invisible
 * unless a renderer is registered for their customType — which, for these,
 * deliberately is not.
 *   session_shutdown    → (unless reload) do one final, awaited sync — this
 *                         is what covers turns still inside the debounce
 *                         window at quit — then build a handoff from this
 *                         session's journal lines and write it.
 *
 * Every network call already fails open with an 800ms timeout inside
 * client.ts (fail-open is a core design rule) — nothing in this file adds its own timeout
 * or throws past that boundary. The sync call additionally trips a
 * session-local circuit breaker after 3 consecutive failures, so a downed
 * service degrades to silence rather than retrying every settled turn.
 *
 * Capture is not gated on `ctx.mode === "tui"`. Such a gate would exist to
 * avoid capturing subagents spawned by a delegation tool —
 * but subagents are spawned with `--no-session` and therefore never have a
 * session file at all (`SessionManager.inMemory`); `getSessionFile()` is
 * `undefined` for them regardless of mode. Gating on that instead is strictly
 * more correct: it still excludes every subagent, AND it captures headless
 * `pi -p` runs and RPC-mode integrations that a mode check would silently drop.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildHandoff } from "./handoff.ts";
import { digestTurn } from "./journal.ts";
import { health, listFacts, searchFacts, recallFacts, recallHistory, getMessage, recentMessages, saveFact, syncSession, writeHandoff, FACT_TYPES, type Fact, type FactType } from "./client.ts";
import { formatStandingRules, GLOBAL_SLUG, RULES_FETCH } from "./rules.ts";
import { projectTagForCwd, projectSlugForCwd } from "./slug.ts";

/** customType for the recalled-handoff block rendered at the top of a session. */
const HANDOFF_ENTRY = "previous-session";
/** customType for one journaled turn. Intentionally has no renderer: it is a
 * persistence record, not something to show the user twice. */
const JOURNAL_ENTRY = "journal-line";
/** How long to wait after a settled turn before syncing, so a burst of quick
 * turns collapses into one sync instead of one per turn. */
const SYNC_DEBOUNCE_MS = 10_000;
/** Consecutive sync failures before the circuit breaker trips for the rest
 * of the session (reset at the next session_start). */
const MAX_SYNC_FAILURES = 3;
/** memory_search default result count and per-result preview length (truncated matches, then expand by id). */
const SEARCH_RESULT_LIMIT = 8;
const SEARCH_PREVIEW_CHARS = 300;

/**
 * Over-fetch multiplier for semantic fact recall.
 *
 * Bookkeeping facts (below) are written on every session, so they are always
 * the newest rows and dominate a recency-weighted ranking. Without headroom
 * the filter can empty an otherwise good result set.
 */
const FACT_OVERFETCH = 5;

/**
 * Tags on auto-generated digests the store writes every session
 * (`session-summary`, `pi:session-topic`). These are machine chatter, not
 * record, and drown out real facts in a recency-weighted ranking.
 *
 * `pi:handoff` and `decision` are deliberately NOT in this set: in a
 * coding-focused store they are exactly the record of prior work the
 * memory exists to recall. An earlier draft dropped all four tags, but that
 * suits a store of general personal facts, where they bury the useful ones;
 * here they ARE the facts. Measured: dropping all four emptied the
 * top-40 recall set for every query tried (40 → 0).
 */
const BOOKKEEPING_TAGS = new Set(["session-summary", "pi:session-topic"]);

function isBookkeeping(fact: Fact): boolean {
	return (fact.tags ?? []).some((tag) => BOOKKEEPING_TAGS.has(tag));
}

/** Merge fact lists in priority order, drop bookkeeping, dedupe by id, cap. */
function mergeFacts(lists: Fact[][], limit: number): Fact[] {
	const seen = new Set<string>();
	const merged: Fact[] = [];
	for (const fact of lists.flat()) {
		if (isBookkeeping(fact) || seen.has(fact.id)) continue;
		seen.add(fact.id);
		merged.push(fact);
		if (merged.length >= limit) break;
	}
	return merged;
}
/** How many decision facts session_start fetches before trimming to budget.
 * Deep fetch (not 25): auto-digests are written every session, so a shallow
 * fetch can bury the newest real handoff/decision under a digest flood
 * (measured: one project's only substantive fact sat at index 31). */
const HANDOFF_FACT_LIMIT = 200;
const DECISION_FACT_LIMIT = 200;
const RECENT_MESSAGE_LIMIT = 10;

/**
 * Recent substantive facts injected at session_start. Over-fetched DEEPLY so
 * that excluding handoffs/decisions/digests (each surfaced in its own block, or
 * filtered as noise) still leaves a full set — digests are written every
 * session and can bury the only real facts (measured: index 31 of 32).
 */
const RECENT_FACTS_FETCH = 200;
const RECENT_FACTS_LIMIT = 8;
/** Char budget for the recent-facts block. 2000 (decisions) + 1600 (facts) +
 * 1200 (handoff) stays under the ~6000-char ceiling for the whole injection. */
const RECENT_FACTS_CHAR_BUDGET = 1600;
const RECENT_FACTS_PREVIEW_CHARS = 200;
/** Char budget for the decisions block specifically. Combined with the
 * handoff's existing 1200-char cap this stays well under a
 * ≤1500-token session-start injection budget (≈4 chars/token, so ~6000
 * chars would be the ceiling — 2000 (decisions) + 1200 (handoff) leaves
 * comfortable margin, not a tight budget scraped to the limit). */
const DECISIONS_CHAR_BUDGET = 2000;

/** Strip the `project:` prefix, since the server's query param wants the raw slug. */
function slugFromTag(tag: string): string {
	return tag.startsWith("project:") ? tag.slice("project:".length) : tag;
}

/**
 * Newest fact tagged `pi:handoff` for `slug`, or undefined if there is none
 * (including when the service is down, since `listFacts` fails open to `[]`).
 * Shared by `session_start` and the `/memory` command.
 */
async function newestHandoff(slug: string): Promise<Fact | undefined> {
	const facts = await listFacts(slug, HANDOFF_FACT_LIMIT);
	const handoffFacts = facts.filter((f: Fact) => Array.isArray(f.tags) && f.tags.includes("pi:handoff"));
	let newest: Fact | undefined;
	for (const f of handoffFacts) {
		if (!newest || f.created_at > newest.created_at) newest = f;
	}
	return newest;
}

/**
 * Recent substantive facts for `slug`, newest first, as a compact bullet list
 * capped to `RECENT_FACTS_CHAR_BUDGET`. Excludes handoffs and decisions (each
 * gets its own injection block) and auto-digests (noise). This is the fix for
 * resuming into a bare handoff: the handoff says what we were doing, these
 * say what is known. Returns "" when there is nothing worth injecting.
 */
async function recentFactsFor(slug: string): Promise<string> {
	const facts = await listFacts(slug, RECENT_FACTS_FETCH);
	const notable = facts.filter((f: Fact) => {
		const tags = f.tags ?? [];
		if (!Array.isArray(tags)) return false;
		if (tags.includes("pi:handoff") || tags.includes("decision")) return false; // own blocks
		return !tags.some((t) => BOOKKEEPING_TAGS.has(t)); // digests are noise
	});
	if (notable.length === 0) return "";

	const lines: string[] = [];
	let used = 0;
	for (const f of notable.slice(0, RECENT_FACTS_LIMIT)) {
		const content = f.content.trim();
		const preview = content.length > RECENT_FACTS_PREVIEW_CHARS ? `${content.slice(0, RECENT_FACTS_PREVIEW_CHARS)}…` : content;
		if (used + preview.length > RECENT_FACTS_CHAR_BUDGET) break;
		lines.push(`- (${f.created_at.slice(0, 10)}) ${preview}`);
		used += preview.length + 1;
	}
	if (lines.length === 0) return "";
	return `## Recent facts for this project\n${lines.join("\n")}\n`;
}

/**
 * Locked decisions for `slug`, formatted as a compact bullet list and capped
 * to `DECISIONS_CHAR_BUDGET`. This is the direct fix for the incident that
 * motivated this feature: an audit agent flagged nine
 * already-settled decisions as open because nothing in memory distinguished
 * LOCKED from merely-discussed. Returns "" (not null) when there are none,
 * so callers can string-concatenate without a null check.
 */
async function decisionsFor(slug: string): Promise<string> {
	const facts = await listFacts(slug, DECISION_FACT_LIMIT);
	const decisions = facts.filter((f: Fact) => Array.isArray(f.tags) && f.tags.includes("decision"));
	if (decisions.length === 0) return "";

	// Newest first — a decision superseded by a later one should read above it.
	decisions.sort((a, b) => b.created_at.localeCompare(a.created_at));

	const lines: string[] = [];
	let used = 0;
	for (const d of decisions) {
		const line = `- ${d.content}`;
		if (used + line.length > DECISIONS_CHAR_BUDGET) break;
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return "";
	return `## Locked decisions for this project\n${lines.join("\n")}\n`;
}

/**
 * This session's journal lines, recovered from its own custom entries.
 *
 * Survives `/reload` (which wipes in-memory state) and `/resume` (which replays
 * the session file), so the handoff always covers the whole session rather than
 * the tail since the last reload.
 */
function journalFromEntries(entries: SessionEntry[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: { line?: unknown } };
		if (e.type === "custom" && e.customType === JOURNAL_ENTRY && typeof e.data?.line === "string") {
			lines.push(e.data.line);
		}
	}
	return lines;
}

/**
 * Text of the last assistant message in `entries`, or null if there isn't
 * one. Used only for the handoff's "Left off" section — distinct from the
 * mechanical journal lines, which are built by `digestTurn`.
 */
function lastAssistantText(entries: SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content.trim() || null;
		if (!Array.isArray(content)) return null;
		const texts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string") texts.push(text);
			}
		}
		const joined = texts.join(" ").trim();
		return joined || null;
	}
	return null;
}

export default function memory(pi: ExtensionAPI) {
	// Renders the recalled handoff as a durable transcript block. Registered
	// unconditionally so replayed entries from earlier sessions still render.
	pi.registerEntryRenderer(HANDOFF_ENTRY, (entry, _options, theme) => {
		const data = (entry.data ?? {}) as { text?: string };
		const box = new Box(1, 0);
		box.addChild(new Text(theme.fg("accent", "Previous session")));
		box.addChild(new Text(theme.fg("dim", data.text ?? "")));
		box.addChild(new Text(theme.fg("dim", "Continue, or work on something else?")));
		return box;
	});

	/** `project:<slug>` for this session's cwd, or null only when cwd itself is empty. */
	let projectTag: string | null = null;
	/** Handoff (or recent-chatter) text found at session_start, held for injection. */
	let previousSessionText: string | undefined;
	/** Facts under project `global` (rules.ts), held for injection ahead of the handoff. */
	let standingRulesText = "";
	/** Guards the one-time system-prompt injection (task requirement: exactly once). */
	let injectedOnce = false;
	/** This session's journal lines, in order — local only; feeds the handoff, never sent over the network. */
	let journalLines: string[] = [];
	/** False when this session has no on-disk file (subagents, in-memory runs): nothing to sync, nothing to recall. */
	let captureEnabled = false;
	/** Consecutive /session/sync failures this session. At MAX_SYNC_FAILURES, syncing stops until the next session_start. */
	let syncFailures = 0;
	/** Pending debounced sync, if any. */
	let syncTimer: ReturnType<typeof setTimeout> | null = null;

	function clearSyncTimer() {
		if (syncTimer) {
			clearTimeout(syncTimer);
			syncTimer = null;
		}
	}

	/** Sync pi's session file to ira-memory. Updates the circuit breaker; never throws. */
	async function doSync(ctx: ExtensionContext, final: boolean): Promise<void> {
		if (!captureEnabled || syncFailures >= MAX_SYNC_FAILURES) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return; // in-memory session — nothing on disk to sync
		const result = await syncSession(sessionFile, ctx.sessionManager.getSessionId(), ctx.cwd, final);
		if (result) {
			syncFailures = 0;
		} else {
			syncFailures++;
		}
	}

	/** Debounce a sync so a burst of quick turns collapses into one request. */
	function scheduleSync(ctx: ExtensionContext) {
		if (!captureEnabled || syncFailures >= MAX_SYNC_FAILURES) return;
		clearSyncTimer();
		syncTimer = setTimeout(() => {
			syncTimer = null;
			void doSync(ctx, false);
		}, SYNC_DEBOUNCE_MS);
	}

	// ── session_start: recall ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		try {
			// Guard on whether this session persists to disk, not on UI mode
			// (see file docstring). delegate's subagents run with --no-session
			// and have no session file regardless of mode, so they are excluded
			// here exactly as before — this just also stops excluding headless
			// `pi -p` runs and future RPC integrations that had no file either.
			captureEnabled = ctx.sessionManager.getSessionFile() !== undefined;
			projectTag = captureEnabled ? projectTagForCwd(ctx.cwd) : null;
			previousSessionText = undefined;
			standingRulesText = "";
			injectedOnce = false;
			journalLines = [];
			syncFailures = 0;
			clearSyncTimer();
			if (!projectTag) return;

			const entries = ctx.sessionManager.getEntries() as SessionEntry[];

			// Reload and resume both land here with turns already behind us.
			journalLines = journalFromEntries(entries);

			const slug = slugFromTag(projectTag);
			// Rules first and independent of the rest: a project with no handoff,
			// decisions or facts yet still gets the user's standing rules.
			standingRulesText = formatStandingRules(await listFacts(GLOBAL_SLUG, RULES_FETCH));
			const newest = await newestHandoff(slug);

			let historyText: string | undefined = newest?.content;
			if (!historyText) {
				const messages = await recentMessages(`pi:${slug}`, RECENT_MESSAGE_LIMIT);
				if (messages.length > 0) historyText = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
			}

			// Decisions, then recent facts, then handoff/recent-chatter (the
			// injection order). Either half can be empty
			// independently — a project with decisions but no handoff yet (or vice
			// versa) still gets whichever half it has.
			const decisionsText = await decisionsFor(slug);
			const factsText = await recentFactsFor(slug);
			const text = decisionsText || factsText || historyText ? `${decisionsText}${factsText}${historyText ?? ""}`.trim() : undefined;
			if (!text) return;

			previousSessionText = text;

			// On resume the prior session's entry is replayed from file; don't stack
			// a second identical copy on top of it.
			const alreadyShown = entries.some((e) => {
				const c = e as { type?: string; customType?: string; data?: { text?: string } };
				return c.type === "custom" && c.customType === HANDOFF_ENTRY && c.data?.text === text;
			});
			if (!alreadyShown) pi.appendEntry(HANDOFF_ENTRY, { text });
		} catch {
			// Recall is best-effort; a broken read must not stop the session.
		}
	});

	// ── before_agent_start: inject into context, once ───────────────────────────

	pi.on("before_agent_start", (event, _ctx) => {
		try {
			if (!projectTag || injectedOnce || (!previousSessionText && !standingRulesText)) return;
			injectedOnce = true;
			const rules = standingRulesText ? `\n\n${standingRulesText.trim()}` : "";
			const previous = previousSessionText ? `\n\n## Previous session\n${previousSessionText}` : "";
			return { systemPrompt: `${event.systemPrompt}${rules}${previous}` };
		} catch {
			return;
		}
	});

	// ── agent_settled: local digest for the handoff + debounced file sync ───────

	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		try {
			if (!projectTag) return;
			const entries = ctx.sessionManager.getEntries() as SessionEntry[];

			// Local only — never sent to ira-memory. Feeds handoff.ts's "Worked
			// on" / "Touched" sections at session_shutdown. See journal.ts's
			// docstring for why this file no longer carries the actual turn.
			const line = digestTurn(entries);
			if (line) {
				journalLines.push(line);
				pi.appendEntry(JOURNAL_ENTRY, { line });
			}

			scheduleSync(ctx);
		} catch {
			// A missed journal entry or sync is not worth crashing a settled turn over.
		}
	});

	// ── session_shutdown: final sync, then write the handoff ────────────────────

	pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
		try {
			if (!projectTag) return;
			if (event.reason === "reload") return;

			// A debounced sync may still be pending — replace it with one final,
			// awaited sync so turns inside the debounce window at quit aren't lost
			// until the next session picks up the file (still recoverable via the
			// startup sweep; session_start doesn't sweep
			// yet, so this final sync is what actually closes the gap).
			clearSyncTimer();
			await doSync(ctx, true);

			const entries = ctx.sessionManager.getEntries() as SessionEntry[];
			const handoff = buildHandoff(journalLines, lastAssistantText(entries));
			if (!handoff) return;

			await writeHandoff(projectTag, handoff);
		} catch {
			// A failed write must not block teardown.
		}
	});

	// ── /memory: status report ──────────────────────────────────────────────────

	pi.registerCommand("memory", {
		description: "Show this session's memory status: project tag, service health, sync state, last handoff",
		handler: async (_args, ctx: ExtensionContext) => {
			const tag = projectTagForCwd(ctx.cwd);
			const hasFile = ctx.sessionManager.getSessionFile() !== undefined;
			const lines: string[] = [
				`project tag   ${tag ?? "(none — empty cwd, nothing is recorded)"}`,
				`recording     ${hasFile ? "yes" : "no (in-memory session — subagent or --no-session run)"}`,
				`sync failures ${syncFailures}${syncFailures >= MAX_SYNC_FAILURES ? " (circuit breaker OPEN — not retrying this session)" : ""}`,
			];

			try {
				const up = await health();
				lines.push(`service       ${up ? `up (${up.backend})` : "down or unreachable"}`);
			} catch (error) {
				lines.push(`service       error checking health: ${(error as Error).message}`);
			}

			lines.push(`journal lines ${journalLines.length} (local — used for the handoff, not sent to ira-memory)`);

			if (!tag) {
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			try {
				const newest = await newestHandoff(slugFromTag(tag));
				lines.push(
					newest
						? `last handoff  (${newest.created_at})\n${newest.content}`
						: "last handoff  none stored for this project",
				);
			} catch (error) {
				lines.push(`last handoff  error fetching: ${(error as Error).message}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── memory_search: on-demand recall over full history ─────────
	// Complements the small, unconditional session_start injection: that
	// carries only the handoff and can't grow without eating context budget on
	// every turn, so it's necessarily shallow. This tool is the deep path —
	// zero cost until the agent decides it needs history, and it can reach the
	// full untruncated text of any prior turn via expandId, not just a summary.

	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description: [
			"Search ira-memory: both curated facts (memory_facts) and full prior session history",
			"(conversation text, both user and assistant turns, and tool activity).",
			"Use this when you need to know what was already decided, tried, or discussed in an earlier",
			"session before asking the user to repeat it or re-deciding it yourself.",
			"Defaults to this project only; pass project:\"all\" to search every project, or a specific",
			"slug to search another one.",
			"Results are truncated previews; pass expandId (from a result's [id=...] tag) to fetch one",
			"result's full, untruncated text in a follow-up call (facts return in full already).",
		].join(" "),
		promptSnippet: "memory_search(query) — search facts + prior session history; project:\"all\" to search every project; memory_search(expandId) to read one result in full",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search text. Omit when using expandId." })),
			expandId: Type.Optional(Type.String({ description: "A message id from a prior search result's [id=...] tag — returns that result's full text." })),
			limit: Type.Optional(Type.Number({ description: `Max results (default ${SEARCH_RESULT_LIMIT}).` })),
			project: Type.Optional(Type.String({ description: 'Project slug to search, or "all" for every project. Defaults to the current project.' })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const slug = projectSlugForCwd(ctx.cwd);
			if (!slug) {
				return { content: [{ type: "text", text: "No project context for this session — nothing to search." }] };
			}

			if (params.expandId) {
				const message = await getMessage(params.expandId);
				if (!message) {
					return { content: [{ type: "text", text: `No message found with id "${params.expandId}" (service may be down, or the id was mistyped).` }] };
				}
				return {
					content: [{ type: "text", text: `[id=${message.id}] [${message.role}] ${message.created_at}\n\n${message.content}` }],
				};
			}

			if (!params.query) {
				return { content: [{ type: "text", text: "Provide either query (to search) or expandId (to read one result in full)." }] };
			}

			const query = params.query;
			const scope = params.project ?? slug;
			const resultLimit = params.limit ?? SEARCH_RESULT_LIMIT;

			// Three sources, not two: keyword facts, semantic facts, and history.
			// `searchFacts` is FTS-only, so a question asked in the user's own
			// wording misses facts that answer it verbatim.
			const [keywordFacts, semanticFacts, history] = await Promise.all([
				searchFacts(query, scope, resultLimit),
				recallFacts(query, resultLimit * FACT_OVERFETCH),
				recallHistory(query, scope, resultLimit),
			]);

			let facts = mergeFacts([semanticFacts, keywordFacts], resultLimit);
			let messages = history;
			let widened = false;

			// Nothing in this project does not mean nothing anywhere. Retry once
			// unscoped before reporting an absence.
			if (facts.length === 0 && messages.length === 0 && scope !== "all") {
				widened = true;
				const [wideFacts, wideHistory] = await Promise.all([
					searchFacts(query, "all", resultLimit),
					recallHistory(query, "all", resultLimit),
				]);
				facts = mergeFacts([wideFacts], resultLimit);
				messages = wideHistory;
			}

			if (facts.length === 0 && messages.length === 0) {
				const where =
					scope === "all"
						? "every project"
						: widened
							? `project ${scope}, then again across every project`
							: `project ${scope}`;
				return {
					content: [
						{
							type: "text",
							text:
								`Searched curated facts (keyword and semantic) and session history in ${where} for "${query}" — no match. ` +
								`This says the query did not match, not that memory is empty. Try different wording or a specific project slug.`,
						},
					],
				};
			}

			const factLines = facts.map((f) => `[fact id=${f.id}] ${f.tags.join(",")}\n${f.content}`);
			const historyLines = messages.map((m) => {
				const preview = m.content.length > SEARCH_PREVIEW_CHARS ? `${m.content.slice(0, SEARCH_PREVIEW_CHARS)}…` : m.content;
				return `[id=${m.id}] [${m.role}] ${m.created_at} (score ${m.score.toFixed(2)})\n${preview}`;
			});

			const sections = [];
			if (factLines.length) sections.push(`## Facts\n\n${factLines.join("\n\n---\n\n")}`);
			if (historyLines.length) sections.push(`## History\n\n${historyLines.join("\n\n---\n\n")}`);

			return {
				content: [{ type: "text", text: `${sections.join("\n\n")}\n\n(Call memory_search again with expandId set to any [id] above for the full, untruncated text of a history result.)` }],
			};
		},
	});

	// ── memory_save: write a curated fact ──────────────────────────────────────────
	// Before this tool, every session found only memory_search in its tool list
	// and had to rediscover the HTTP API to write anything (it happened
	// repeatedly). The tool list is the one thing every session reads.

	pi.registerTool({
		name: "memory_save",
		label: "Memory save",
		description: [
			"Save a curated fact to ira-memory, the user's source of truth across every project and session.",
			"Save anything a later session must know: decisions, the user's rules and preferences, findings,",
			"what was verified and how, status, open questions. Files in the repo are not enough on their own.",
			"One idea per fact, self-contained, dated, with the why. Defaults to the current project.",
			'Use project:"global" for rules and preferences that apply to every project: those are injected',
			"into every new session's system prompt. Add the tag \"decision\" to a locked decision so it is",
			"injected at the start of this project's sessions.",
		].join(" "),
		promptSnippet:
			'memory_save(content, type?, project?, tags?) — save a curated fact to ira-memory; project:"global" for rules that apply everywhere; tag "decision" for locked decisions',
		parameters: Type.Object({
			content: Type.String({ description: "The fact, self-contained: what, why, date, and how it was verified." }),
			type: Type.Optional(
				Type.Union(FACT_TYPES.map((t) => Type.Literal(t)), {
					description: 'user = preference or rule, feedback = lesson, project = project state (default), reference = context.',
				}),
			),
			project: Type.Optional(Type.String({ description: 'Project slug. Defaults to the current project. "global" for rules that apply everywhere.' })),
			tags: Type.Optional(Type.Array(Type.String(), { description: 'Extra tags, e.g. ["decision"] or ["rules"].' })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const project = params.project ?? projectSlugForCwd(ctx.cwd);
			if (!project) {
				return { content: [{ type: "text", text: 'No project for this cwd. Pass project (a slug, or "global"). Nothing was saved.' }] };
			}
			if (!params.content.trim()) {
				return { content: [{ type: "text", text: "content is empty. Nothing was saved." }] };
			}
			const fact = await saveFact({
				content: params.content,
				type: (params.type ?? (project === GLOBAL_SLUG ? "user" : "project")) as FactType,
				project,
				...(params.tags ? { tags: params.tags } : {}),
			});
			if (!fact) {
				return {
					content: [{ type: "text", text: "ira-memory did not accept the fact (service down at 127.0.0.1:7775, or a non-2xx). Nothing was saved." }],
				};
			}
			return { content: [{ type: "text", text: `Saved [fact id=${fact.id}] ${fact.tags.join(",")}\n${fact.content}` }] };
		},
	});

	// ── /handoff: checkpoint now ─────────────────────────────────────────────────

	pi.registerCommand("handoff", {
		description: "Build and write a handoff for this session right now, without quitting",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!projectTag) {
				ctx.ui.notify("No project tag for this session — nothing to write.", "warning");
				return;
			}

			try {
				const entries = ctx.sessionManager.getEntries() as SessionEntry[];
				const handoff = buildHandoff(journalLines, lastAssistantText(entries));
				if (!handoff) {
					ctx.ui.notify("No journal entries yet this session — nothing to write.", "info");
					return;
				}

				const result = await writeHandoff(projectTag, handoff);
				if (!result) {
					ctx.ui.notify(`Handoff write failed (service down or unreachable). Would have written:\n\n${handoff}`, "error");
					return;
				}

				ctx.ui.notify(`Handoff written for ${projectTag}:\n\n${handoff}`, "info");
			} catch (error) {
				ctx.ui.notify(`Handoff failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
