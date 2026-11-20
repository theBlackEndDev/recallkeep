/**
 * Standing rules: facts that apply to every project and every session.
 *
 * They live under the reserved project slug `global`, because
 * `GET /memory/list?project=` is the only filter the server applies in the
 * database. An unscoped list is capped at the 500 newest facts, so a rule
 * written months ago would fall off it. Saved with `memory_save` and
 * `project: "global"`.
 */

import type { Fact } from "./client.ts";

export const GLOBAL_SLUG = "global";
export const RULES_FETCH = 100;
export const RULES_CHAR_BUDGET = 2000;

/** Bookkeeping that the server or the extension writes, never a rule. */
const NOT_RULES = new Set(["pi:handoff", "session-summary", "pi:session-topic"]);

/**
 * Oldest first, so the order rules were set in is the order they read in.
 * Each fact is kept whole or dropped: a rule cut mid-sentence can say the
 * opposite of what it meant. Returns "" when there are none.
 */
export function formatStandingRules(facts: Fact[], budget = RULES_CHAR_BUDGET): string {
	const rules = facts
		.filter((f) => !(f.tags ?? []).some((t) => NOT_RULES.has(t)))
		.sort((a, b) => a.created_at.localeCompare(b.created_at));
	const lines: string[] = [];
	let used = 0;
	for (const f of rules) {
		const line = `- ${f.content.trim().replace(/^\[global\]\s*/, "")}`;
		if (used + line.length > budget) break;
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return "";
	return `## Standing rules (RecallKeep, every project)\n${lines.join("\n")}\n`;
}
