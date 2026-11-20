/**
 * Session handoff.
 *
 * Assembles a human-readable handoff from journal lines already on disk —
 * no LLM call, no network. This runs in the `session_shutdown` path, which
 * is awaited but unbudgeted; a mechanical summary that always completes is
 * safer than a summarizer that might get killed mid-flight.
 *
 * Journal lines are in the format produced by `digestTurn()`:
 *   "Request: ... — Tools: ... — Files: ... — Bash: ..."
 * (the "Tools:", "Files:", and "Bash:" segments are each optional).
 */

import { isSyntheticUserText, truncateWords } from "./journal.ts";

const MAX_HANDOFF_LENGTH = 1200;
const MAX_ASSISTANT_LENGTH = 400;

/**
 * Hard cut, used where the cap protects a storage budget rather than a reader
 * (the whole-handoff cap). Mid-word is acceptable there because nothing
 * downstream quotes it back as prose.
 */
function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) : s;
}

/**
 * Pulls the value of a labeled segment (e.g. "Request", "Files") out of a
 * single journal line built with the "Label: value — Label: value" format.
 * Returns null if the label is not present on the line.
 */
function extractSection(line: string, label: string): string | null {
	const marker = `${label}: `;
	const idx = line.indexOf(marker);
	if (idx === -1) return null;
	const start = idx + marker.length;
	const rest = line.slice(start);
	const sepIdx = rest.indexOf(" — ");
	return sepIdx === -1 ? rest : rest.slice(0, sepIdx);
}

/**
 * Builds a handoff summary from this session's journal lines and its final
 * assistant message. Returns null when `journalLines` is empty, so an idle
 * session (one that never did a turn) writes nothing.
 */
export function buildHandoff(journalLines: string[], lastAssistantText: string | null): string | null {
	if (!Array.isArray(journalLines) || journalLines.length === 0) return null;

	const subjects: string[] = [];
	const filePaths: string[] = [];

	for (const line of journalLines) {
		const request = extractSection(line, "Request");
		// Filtered here as well as in journal.ts: journal lines are replayed from
		// session files written before that fix, and those already contain gate
		// text as a "Request". Dropping it at read time is what keeps an old
		// session's handoff from being three gate messages and nothing else.
		if (request && !isSyntheticUserText(request) && !subjects.includes(request)) subjects.push(request);

		const files = extractSection(line, "Files");
		if (!files) continue;
		for (const rawPath of files.split(", ")) {
			const path = rawPath.trim();
			if (path && !filePaths.includes(path)) filePaths.push(path);
		}
	}

	const workedOnBody = subjects.length ? subjects.map((s) => `- ${s}`).join("\n") : "- (nothing distinct)";
	const touchedBody = filePaths.length ? filePaths.map((p) => `- ${p}`).join("\n") : "- (no files)";
	const leftOffBody = lastAssistantText ? truncateWords(lastAssistantText, MAX_ASSISTANT_LENGTH) : "(no final message)";

	const result = [`Worked on:\n${workedOnBody}`, `Touched:\n${touchedBody}`, `Left off:\n${leftOffBody}`].join("\n\n");

	return truncate(result, MAX_HANDOFF_LENGTH);
}
