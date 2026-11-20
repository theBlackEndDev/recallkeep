/**
 * Turn journal. Its scope is deliberately narrow — see index.ts's file
 * docstring for why the full transcript is synced from disk instead.
 *
 * Mechanically digests the most recent completed turn from pi's session
 * entries into a single plain-text line. No LLM call: this runs in the
 * `agent_settled` hook and must be cheap and synchronous.
 *
 * This digest is now used ONLY to build the local `session_shutdown`
 * handoff (`handoff.ts`'s `buildHandoff` parses its "Label: value" format).
 * It is never sent to recallkeep. Assistant text is deliberately absent from
 * it — it was never meant to carry the full turn, only enough of the user's
 * ask and the tool trail to reconstruct a "Worked on" / "Touched" summary at
 * quit time. The full turn (both roles, untruncated) reaches recallkeep a
 * different way now: `index.ts`'s `agent_settled`/`session_shutdown` hooks
 * sync pi's own session *file* to `POST /session/sync`, and recallkeep reads
 * the transcript itself. If you are looking for "where does the model's
 * answer get stored", it is not in this file — see `client.ts`'s
 * `syncSession`.
 *
 * Turn boundary: the last `message` entry with `role: "user"` in `entries`,
 * plus everything after it (assistant messages carrying `toolCall` blocks).
 * If no user message exists anywhere in `entries`, there is no turn to
 * digest and we return null.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const MAX_LINE_LENGTH = 500;
const MAX_REQUEST_LENGTH = 120;
const MAX_BASH_LENGTH = 80;

/**
 * Openers of extension-injected pseudo-user messages.
 *
 * `pi.sendUserMessage()` delivers an extension's text as a genuine
 * `role: "user"` entry — the session file cannot tell it apart from something
 * the human typed. A verification-gate extension may use it on every unsupported
 * claim, so its follow-up becomes the "last user message", and this digest
 * then recorded the gate's own text as the turn's request. Measured: a
 * handoff fact whose "Worked on" list was three gate messages
 * and a fragment of a quoted claim, with the actual session's work absent.
 *
 * Matched on the literal opener rather than a flag because no flag survives
 * the round-trip to the session file. Keep this list short and exact: a loose
 * pattern here silently drops the user's real requests, which is the worse
 * failure of the two.
 */
const SYNTHETIC_USER_PREFIXES = [
	"Verification gate: this turn made a claim",
];

/**
 * True when `text` is an extension-injected pseudo-user message rather than
 * something the human actually asked for. Exported because `handoff.ts` must
 * apply the same filter to journal lines already written to older session
 * files, which this fix cannot retroactively clean.
 */
export function isSyntheticUserText(text: string): boolean {
	const trimmed = text.trimStart();
	return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts.join(" ").trim();
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) : s;
}

/**
 * Cut at the last word boundary at or before `max`, marking the cut with an
 * ellipsis. Shared with `handoff.ts`.
 *
 * A hard `slice()` ends the request mid-word, which reads downstream as a
 * corrupted record rather than an abbreviated one — the difference between
 * "cutting back to Sonnet once the…" and "cutting back to Sonnet once the".
 * Falls back to a hard cut when there is no whitespace before `max` (a single
 * long token: a path, a hash, a pasted blob).
 */
export function truncateWords(s: string, max: number): string {
	if (s.length <= max) return s;
	const clipped = s.slice(0, max);
	const lastSpace = clipped.search(/\s\S*$/);
	const body = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
	return `${body.trimEnd()}\u2026`;
}

/**
 * Digests the most recent completed turn in `entries` into a single
 * plain-text summary line, or null if the last turn has no user message.
 */
export function digestTurn(entries: SessionEntry[]): string | null {
	if (!Array.isArray(entries) || entries.length === 0) return null;

	// Walk back past injected pseudo-user turns to the human's actual request.
	// The tool scan then starts from THAT index, so work done after a gate
	// message is still attributed to the request that prompted it instead of
	// being split onto a turn labelled with the gate's own text.
	let lastUserIndex = -1;
	let userText = "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = extractText(entry.message?.content);
		if (!text || isSyntheticUserText(text)) continue;
		lastUserIndex = i;
		userText = text;
		break;
	}
	if (lastUserIndex === -1) return null;

	const toolNames: string[] = [];
	const filePaths: string[] = [];
	const bashCommands: string[] = [];

	for (let i = lastUserIndex; i < entries.length; i++) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;

		for (const block of content) {
			if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") continue;
			const toolCall = block as { name?: unknown; arguments?: Record<string, unknown> };
			const name = toolCall.name;
			if (typeof name !== "string") continue;

			if (!toolNames.includes(name)) toolNames.push(name);

			const args = toolCall.arguments;
			if ((name === "write" || name === "edit") && args && typeof args.path === "string") {
				if (!filePaths.includes(args.path)) filePaths.push(args.path);
			}
			if (name === "bash" && args && typeof args.command === "string") {
				bashCommands.push(truncate(args.command, MAX_BASH_LENGTH));
			}
		}
	}

	const parts: string[] = [`Request: ${truncateWords(userText, MAX_REQUEST_LENGTH)}`];
	if (toolNames.length) parts.push(`Tools: ${toolNames.join(", ")}`);
	if (filePaths.length) parts.push(`Files: ${filePaths.join(", ")}`);
	if (bashCommands.length) parts.push(`Bash: ${bashCommands.join(" | ")}`);

	return truncate(parts.join(" — "), MAX_LINE_LENGTH);
}
