import { digestTurn, isSyntheticUserText } from "./journal.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

let pass = 0, fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
	if (got === want) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// Synthetic entry factories. Only the fields digestTurn() reads (type, role,
// content, toolCall name/arguments) vary between cases; everything else is
// filler required to satisfy the real AssistantMessage/UserMessage shape.
let nextId = 0;
function id(): string {
	return `e${nextId++}`;
}

function userEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: id(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	} as SessionEntry;
}

function toolCall(name: string, args: Record<string, unknown>) {
	return { type: "toolCall", id: id(), name, arguments: args };
}

function assistantEntry(blocks: unknown[]): SessionEntry {
	return {
		type: "message",
		id: id(),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: blocks,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		},
	} as SessionEntry;
}

// --- digestTurn(): empty array returns null ---

check("empty array returns null", digestTurn([]), null);

// --- digestTurn(): no user message anywhere returns null ---

const noUser: SessionEntry[] = [assistantEntry([{ type: "text", text: "hello" }])];
check("no user message returns null", digestTurn(noUser), null);

// --- digestTurn(): turn with no tools summarizes the request alone ---

const noTools: SessionEntry[] = [
	userEntry("Just tell me what time it is"),
	assistantEntry([{ type: "text", text: "It's noon." }]),
];
const noToolsLine = digestTurn(noTools);
check("no-tools line is not null", noToolsLine !== null, true);
check("no-tools line has request", (noToolsLine ?? "").includes("Request: Just tell me what time it is"), true);
check("no-tools line has no Tools section", (noToolsLine ?? "").includes("Tools:"), false);
check("no-tools line has no Files section", (noToolsLine ?? "").includes("Files:"), false);
check("no-tools line has no Bash section", (noToolsLine ?? "").includes("Bash:"), false);

// --- digestTurn(): turn with edits and bash collects tools, dedupes paths, truncates commands ---

const longCommand = "echo " + "x".repeat(200);
const withTools: SessionEntry[] = [
	userEntry("Fix the bug in journal.ts and run the tests"),
	assistantEntry([
		{ type: "text", text: "Looking into it." },
		toolCall("edit", { path: "/workspace/dev/.pi/agent/extensions/memory/journal.ts", edits: [] }),
		toolCall("edit", { path: "/workspace/dev/.pi/agent/extensions/memory/journal.ts", edits: [] }),
		toolCall("write", { path: "/workspace/dev/.pi/agent/extensions/memory/journal.test.ts", content: "" }),
		toolCall("bash", { command: "bun test journal.test.ts" }),
		toolCall("bash", { command: longCommand }),
	]),
];
const withToolsLine = digestTurn(withTools);
check("with-tools line is not null", withToolsLine !== null, true);
const line = withToolsLine ?? "";
check("with-tools line has request", line.includes("Request: Fix the bug in journal.ts and run the tests"), true);
check("with-tools line lists distinct tools once each", line.includes("Tools: edit, write, bash"), true);
const filesSection = line.slice(line.indexOf("Files:"), line.indexOf("Bash:"));
check("with-tools line dedupes the repeated edit path", (filesSection.match(/journal\.ts/g) ?? []).length, 1);
check("with-tools line includes the write path", line.includes("journal.test.ts"), true);
const truncatedCommand = longCommand.slice(0, 80);
check("with-tools line truncates the long bash command to 80 chars", line.includes(truncatedCommand), true);
check("with-tools line does not include the full 200-char command", line.includes(longCommand), false);
check("with-tools line stays under the 500-char cap", line.length <= 500, true);

// --- digestTurn(): the request text itself is truncated to 120 chars ---

const longRequest = "a".repeat(300);
const withLongRequest: SessionEntry[] = [userEntry(longRequest)];
const longRequestLine = digestTurn(withLongRequest) ?? "";
check("request is truncated to 120 chars", longRequestLine.includes("a".repeat(120)), true);
check("request truncation excludes the 121st char run", longRequestLine.includes("a".repeat(121)), false);

// --- digestTurn(): only the entries from the last user message onward count ---

const twoTurns: SessionEntry[] = [
	userEntry("first turn"),
	assistantEntry([toolCall("bash", { command: "echo first" })]),
	userEntry("second turn"),
	assistantEntry([toolCall("write", { path: "/tmp/second.txt", content: "" })]),
];
const secondTurnLine = digestTurn(twoTurns) ?? "";
check("only the latest turn's request is used", secondTurnLine.includes("second turn"), true);
check("only the latest turn's request is used (not the first)", secondTurnLine.includes("first turn"), false);
check("only the latest turn's tools are used", secondTurnLine.includes("/tmp/second.txt"), true);
check("earlier turn's tool call does not leak in", secondTurnLine.includes("echo first"), false);

// --- isSyntheticUserText(): matches injected gate text, not real requests ---

const gateText = 'Verification gate: this turn made a claim its own tool calls do not support.\n\nClaim: "18 tests pass"';
check("gate follow-up is synthetic", isSyntheticUserText(gateText), true);
check("leading whitespace still matches", isSyntheticUserText(`\n  ${gateText}`), true);
check("an ordinary request is not synthetic", isSyntheticUserText("Check the handoff and lets resume the plan"), false);
check(
	"a request merely mentioning the gate is not synthetic",
	isSyntheticUserText("why did the Verification gate: this turn made a claim message fire?"),
	false,
);

// --- digestTurn(): an injected gate turn is skipped for the real request ---

const withGateTurn: SessionEntry[] = [
	userEntry("Check the handoff and lets resume the plan"),
	assistantEntry([toolCall("bash", { command: "git log --oneline" })]),
	userEntry(gateText),
	assistantEntry([toolCall("edit", { path: "/tmp/after-gate.md", edits: [] })]),
];
const gateLine = digestTurn(withGateTurn) ?? "";
check("request is the human's, not the gate's", gateLine.includes("Request: Check the handoff"), true);
check("gate text never becomes the request", gateLine.includes("Verification gate"), false);
check("work done before the gate is kept", gateLine.includes("git log --oneline"), true);
check("work done after the gate is kept", gateLine.includes("/tmp/after-gate.md"), true);

// --- digestTurn(): a session with only injected user turns has nothing to record ---

const onlyGate: SessionEntry[] = [userEntry(gateText), assistantEntry([toolCall("bash", { command: "echo hi" })])];
check("a gate-only session returns null", digestTurn(onlyGate), null);

console.log(`\n${pass} passed, ${fail} failed`);
// Only exit on failure: exiting 0 here would kill the shared bun process before
// any sibling test file in the same `bun test` run had a chance to load.
if (fail) process.exit(1);
