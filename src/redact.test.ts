// Phase 2 redaction engine chain: betterleaks -> gitleaks -> heuristic.
// No DB dependency — pure/subprocess only, safe to run in CI.

import { test, expect } from "bun:test";
import { redactSecrets, redactBatch, redactHeuristic, runScanner } from "./redact.js";

/** Test-only helper: run just the CLI layer (betterleaks -> gitleaks), no heuristic on top. */
async function scanCliOnly(text: string): Promise<unknown[] | null> {
  const bl = await runScanner("betterleaks", ["stdin", "--report-path", "-", "--report-format", "json", "--validation=false", "--no-banner", "--no-color", "--log-level", "error", "--exit-code", "0"], text);
  if (bl !== null) return bl;
  return runScanner("gitleaks", ["stdin", "--report-path", "-", "--report-format", "json", "--no-banner", "--log-level", "error", "--exit-code", "0"], text);
}
import { readFileSync } from "node:fs";

// A realistic (high-entropy) fake secret. Real scanners reject sequential/
// low-entropy strings on purpose (that's the "rare not random" filtering
// this phase exists to get) — a fixture must look like an actual key.
const REALISTIC_KEY = "REDACTED-FIXTURE-2";
const REALISTIC_GH_TOKEN = "REDACTED-FIXTURE-3";
// Synthetic key in the SAME shape as a real one found in this codebase's own
// session transcripts during Phase 4 backfill (sk-ant-sid01- prefix, same
// rough length/charset) — NOT the real value; that would be a secret in the
// repo, which is exactly the class of bug this test exists to catch. Neither
// betterleaks nor gitleaks recognize this Anthropic session-key shape at all
// (verified directly against the real key: both returned `[]`), and the
// surrounding code (`injectedKey = "..."`) doesn't trigger either engine's
// keyword prefilter. This is the exact miss that corrected the engine chain
// from a waterfall to a composed (CLI + always-on heuristic) design — see
// redact.ts's module docstring.
const MISSED_BY_CLI_ENGINES = "REDACTED-FIXTURE-1";

// --- redactHeuristic: pure function, unchanged from Phase 1 ---
test("redactHeuristic still works standalone", () => {
  const r = redactHeuristic("OPENAI_API_KEY=REDACTED-FIXTURE-5");
  expect(r.redacted).toBe(true);
  expect(r.engine).toBe("heuristic");
});

// --- engine chain picks a real scanner when installed ---
// Both the CLI engine AND heuristic match this key shape, so the engine
// tag reflects both having contributed — that's the corrected, composed
// design (see redact.ts's module docstring), not a bug.
const realisticResult = redactSecrets(`OPENAI_API_KEY=${REALISTIC_KEY}`);
test("realistic key is caught by the installed engine chain", async () => {
  expect((await realisticResult).redacted).toBe(true);
});
test("the actual secret value does not survive", async () => {
  expect((await realisticResult).content.includes(REALISTIC_KEY)).toBe(false);
});
test("surrounding context (key name) survives", async () => {
  expect((await realisticResult).content.includes("OPENAI_API_KEY=")).toBe(true);
});
// The two tests below need a real scanner binary on PATH. Without one, redaction falls back to the
// heuristic layer alone (still tested above), so they are skipped rather than failed.
const hasScanner = Boolean(Bun.which("betterleaks") || Bun.which("gitleaks"));

test.skipIf(!hasScanner)("engine includes a real scanner, not heuristic-only", async () => {
  const { engine } = await realisticResult;
  expect(engine.includes("betterleaks") || engine.includes("gitleaks")).toBe(true);
});

// --- the CLI engines alone do NOT flag this (Phase 2's original goal) ---
// This is still true and still worth proving: betterleaks/gitleaks, taken
// alone, correctly ignore prose that merely mentions a KEY=value shape.
// What changed (see below) is that the FINAL composed result no longer
// relies on the CLI engines' silence as authoritative.
test.skipIf(!hasScanner)("betterleaks/gitleaks ALONE find nothing in prose about an already-redacted key", async () => {
  const prose = "the surrounding name — `OPENAI_API_KEY=[REDACTED]` preserves the meaning";
  const cliOnly = await scanCliOnly(prose);
  expect(cliOnly).not.toBeNull();
  expect(cliOnly!.length).toBe(0);
});

// --- the corrected behavior: heuristic still catches what CLI engines miss ---
// A pure "prefer the accurate engine" design would have left this exact
// secret in Postgres forever (it did, briefly, during Phase 4's real
// backfill — this test is the regression guard for that).
const missedResult = redactSecrets(`let injectedKey = "${MISSED_BY_CLI_ENGINES}"`);
test("the Anthropic-key-shaped secret IS caught by the composed engine (heuristic layer)", async () => {
  expect((await missedResult).redacted).toBe(true);
});
test("the real Anthropic-shaped secret value does not survive", async () => {
  expect((await missedResult).content.includes(MISSED_BY_CLI_ENGINES)).toBe(false);
});
test("engine tag reflects heuristic's contribution", async () => {
  expect(["betterleaks+heuristic", "gitleaks+heuristic", "heuristic"]).toContain((await missedResult).engine);
});

// --- accepted cost of the correction: the plan-doc FP returns ---
// Documented, not silently regressed: D8's own asymmetry ( over-redaction
// recoverable, under-redaction not) is why this is the right trade to make.
const planPath = "/home/dev/Projects/Plans/pi-recallkeep-capture.md";
let planText: string | null = null;
try {
  planText = readFileSync(planPath, "utf-8");
} catch {
  // Plan doc may not exist in every environment this test runs in — skipped then.
}
test.skipIf(!planText)("plan doc IS flagged (heuristic layer catches its own KEY=value example prose — accepted D8 trade-off)", async () => {
  const r = await redactSecrets(planText!);
  expect(r.redacted).toBe(true);
});

// --- redactBatch: one scan, multiple texts, correctly split back ---
const batchTexts = [
  "just a normal message about deploying the app",
  `here's the token: ${REALISTIC_GH_TOKEN} — save it somewhere safe`,
  "another normal message, nothing to see here",
];
const batchResult = redactBatch(batchTexts);
test("batch returns one entry per input text", async () => {
  expect((await batchResult).texts.length).toBe(3);
});
test("batch[0]: untouched normal text", async () => {
  expect((await batchResult).redacted[0]).toBeFalsy();
});
test("batch[1]: secret caught", async () => {
  expect((await batchResult).redacted[1]).toBe(true);
});
test("batch[1]: secret value removed", async () => {
  expect((await batchResult).texts[1].includes(REALISTIC_GH_TOKEN)).toBe(false);
});
test("batch[1]: surrounding context preserved", async () => {
  expect((await batchResult).texts[1].includes("here's the token:")).toBe(true);
});
test("batch[2]: untouched normal text (not corrupted by batching)", async () => {
  expect((await batchResult).redacted[2]).toBeFalsy();
});
test("batch[2]: byte-identical to input", async () => {
  expect((await batchResult).texts[2]).toBe(batchTexts[2]);
});

// --- empty input ---
test("empty batch returns empty", async () => {
  const empty = await redactBatch([]);
  expect(empty.texts.length).toBe(0);
});

// --- fallback chain: a missing binary returns null, not a throw ---
// This is the exact failure mode redactSecrets/redactBatch depend on to
// fall through betterleaks -> gitleaks -> heuristic. (Testing this via a
// real "no scanner installed" environment isn't reliably reproducible here
// since Bun.spawn resolves PATH from an internal cache at call time, not
// from process.env.PATH mutated at runtime — verified directly. A bogus
// binary name exercises the same ENOENT path deterministically.)
test("runScanner returns null (not a throw) for a nonexistent binary", async () => {
  const missing = await runScanner("this-binary-does-not-exist-recallkeep-test", [], "anything");
  expect(missing).toBeNull();
});

// --- and the documented consequence: redactHeuristic alone is what a
// real "nothing installed" environment would fall back to. ---
test("heuristic tier alone still redacts an obviously-shaped secret", () => {
  const r = redactHeuristic("OPENAI_API_KEY=REDACTED-FIXTURE-5");
  expect(r.redacted).toBe(true);
  expect(r.engine).toBe("heuristic");
});
