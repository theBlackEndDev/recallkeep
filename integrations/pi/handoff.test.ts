import { buildHandoff } from "./handoff.ts";

let pass = 0, fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
	if (got === want) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// --- buildHandoff(): empty journal returns null, so an idle session writes nothing ---

check("empty journal returns null", buildHandoff([], "some final message"), null);
check("empty journal returns null even with null assistant text", buildHandoff([], null), null);

// --- buildHandoff(): duplicate file paths across journal lines are deduplicated ---

const journalWithDupes = [
	"Request: Fix the bug in journal.ts — Tools: edit — Files: /workspace/dev/.pi/agent/extensions/memory/journal.ts",
	"Request: Add tests for journal.ts — Tools: write, bash — Files: /workspace/dev/.pi/agent/extensions/memory/journal.ts, /workspace/dev/.pi/agent/extensions/memory/journal.test.ts — Bash: bun test",
];
const dedupedHandoff = buildHandoff(journalWithDupes, "Both tests pass now.");
check("handoff with dupes is not null", dedupedHandoff !== null, true);
const dedupedBody = dedupedHandoff ?? "";
check("handoff has a Worked on section", dedupedBody.includes("Worked on:"), true);
check("handoff has a Touched section", dedupedBody.includes("Touched:"), true);
check("handoff has a Left off section", dedupedBody.includes("Left off:"), true);
const touchedSection = dedupedBody.slice(dedupedBody.indexOf("Touched:"), dedupedBody.indexOf("Left off:"));
const touchedLines = touchedSection.split("\n").filter((l) => l.startsWith("- "));
check("Touched section lists exactly two distinct paths", touchedLines.length, 2);
check(
	"the repeated edit path appears exactly once in the Touched section",
	touchedLines.includes("- /workspace/dev/.pi/agent/extensions/memory/journal.ts"),
	true,
);
check("journal.test.ts still appears in the Touched section", touchedSection.includes("journal.test.ts"), true);
check("both distinct requests appear in Worked on", dedupedBody.includes("Fix the bug in journal.ts") && dedupedBody.includes("Add tests for journal.ts"), true);
check("final assistant text appears in Left off", dedupedBody.includes("Both tests pass now."), true);

// --- buildHandoff(): an over-long assistant message is truncated, and the whole handoff stays under 1200 chars ---

const longAssistantText = "z".repeat(5000);
const oneLineJournal = ["Request: Do one small thing — Tools: bash — Bash: echo hi"];
const longHandoff = buildHandoff(oneLineJournal, longAssistantText);
check("long handoff is not null", longHandoff !== null, true);
const longBody = longHandoff ?? "";
check("long handoff stays under 1200 chars", longBody.length <= 1200, true);
check("long handoff does not include the full 5000-char message", longBody.includes(longAssistantText), false);
check("long handoff includes the truncated 400-char prefix", longBody.includes("z".repeat(400)), true);
check("long handoff does not include a 401-char run of z", longBody.includes("z".repeat(401)), false);

// --- buildHandoff(): injected gate text in an OLD journal line is dropped ---

// Journal lines are replayed from session files written before the journal.ts
// filter existed, so the read-time filter is what protects those sessions.
const journalWithGate = [
	"Request: Resume the openclaw import \u2014 Tools: bash \u2014 Files: /tmp/a.md",
	'Request: Verification gate: this turn made a claim its own tool calls do not support. Claim: "58 tests pass" \u2014 Tools: bash',
];
const gateHandoff = buildHandoff(journalWithGate, "Done.") ?? "";
check("real request survives", gateHandoff.includes("- Resume the openclaw import"), true);
check("gate text is dropped from Worked on", gateHandoff.includes("Verification gate"), false);

// --- buildHandoff(): a journal of nothing but gate lines degrades honestly ---

const onlyGateJournal = ['Request: Verification gate: this turn made a claim its own tool calls do not support. \u2014 Tools: bash'];
const onlyGateHandoff = buildHandoff(onlyGateJournal, "Done.") ?? "";
check("gate-only journal says nothing distinct", onlyGateHandoff.includes("- (nothing distinct)"), true);

// --- buildHandoff(): Left off is cut at a word boundary, not mid-word ---

const longAssistant = `${"word ".repeat(200)}FINALTOKEN`;
const wrappedHandoff = buildHandoff(["Request: do a thing \u2014 Tools: bash"], longAssistant) ?? "";
const leftOff = wrappedHandoff.slice(wrappedHandoff.indexOf("Left off:") + "Left off:\n".length);
check("Left off is truncated", leftOff.length < longAssistant.length, true);
check("Left off marks the cut with an ellipsis", leftOff.endsWith("\u2026"), true);
// The source repeats "word ", so a boundary cut can only ever end in the
// complete token; any mid-word cut leaves a prefix ("wor\u2026", "wo\u2026", "w\u2026").
check("Left off ends on a complete word", leftOff.endsWith("word\u2026"), true);
check("Left off has no trailing space before the ellipsis", leftOff.includes(" \u2026"), false);

// --- buildHandoff(): a single unbroken token still gets cut (no infinite text) ---

const oneLongToken = "x".repeat(900);
const tokenHandoff = buildHandoff(["Request: do a thing \u2014 Tools: bash"], oneLongToken) ?? "";
check("an unbroken token is still truncated", tokenHandoff.includes("x".repeat(900)), false);
check("an unbroken token is cut to the cap", tokenHandoff.includes("x".repeat(400)), true);

// --- buildHandoff(): short text is untouched (no stray ellipsis) ---

const shortHandoff = buildHandoff(["Request: do a thing \u2014 Tools: bash"], "All done.") ?? "";
check("short Left off is verbatim", shortHandoff.includes("Left off:\nAll done."), true);

console.log(`\n${pass} passed, ${fail} failed`);
// Only exit on failure: exiting 0 here would kill the shared bun process before
// any sibling test file in the same `bun test` run had a chance to load.
if (fail) process.exit(1);
