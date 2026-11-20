/**
 * formatStandingRules: which global facts reach the system prompt, in what order.
 */

import type { Fact } from "./client.ts";
import { formatStandingRules } from "./rules.ts";

let pass = 0, fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const fact = (id: string, content: string, created_at: string, tags = ["friday:user", "project:global"]): Fact => ({
	id, name: null, type: "user", description: null, content, category: "PREFERENCE", tier: "LONG_TERM", tags, created_at,
});

check("no facts → empty string", formatStandingRules([]), "");

check(
	"oldest first, [global] prefix stripped",
	formatStandingRules([
		fact("b", "[global] Ask first, don't assume.", "2026-11-06T00:00:00Z"),
		fact("a", "[global] ira-memory is the source of truth.", "2026-11-05T00:00:00Z"),
	]),
	"## Standing rules (ira-memory, every project)\n- ira-memory is the source of truth.\n- Ask first, don't assume.\n",
);

check(
	"handoffs and digests are not rules",
	formatStandingRules([
		fact("h", "[global] Worked on: x", "2026-11-05T00:00:00Z", ["project:global", "pi:handoff"]),
		fact("d", "[global] digest", "2026-11-05T00:00:00Z", ["project:global", "session-summary"]),
	]),
	"",
);

check(
	"a rule that would overflow the budget is dropped whole, not cut",
	formatStandingRules(
		[fact("a", "short rule", "2026-11-05T00:00:00Z"), fact("b", "x".repeat(50), "2026-11-06T00:00:00Z")],
		30,
	),
	"## Standing rules (ira-memory, every project)\n- short rule\n",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
