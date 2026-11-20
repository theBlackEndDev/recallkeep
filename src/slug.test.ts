// Pure unit test for deriveProjectSlug — no DB, no network. Kept separate
// from test-e2e.ts (which requires a live Postgres) so `bun test` can run
// this one in CI without a database.
//
// Parity contract: the pi extension (~/.pi/agent/extensions/memory/slug.ts,
// projectSlugForCwd) implements the identical three-rule algorithm and
// carries the same fixture list in its slug.test.ts. There is no shared
// package between the two repos — if you change the algorithm here, change
// it there too, and re-run both.

import { test, expect } from "bun:test";
import { deriveProjectSlug } from "./summarize.js";

// --- nested paths collapse to the project root ---
test("nested path collapses to project root", () => {
  expect(deriveProjectSlug("/home/dev/Projects/ira-memory/src/db")).toBe("ira-memory");
});
test("project root, no trailing slash", () => {
  expect(deriveProjectSlug("/home/dev/Projects/ira-memory")).toBe("ira-memory");
});
test("project root, trailing slash", () => {
  expect(deriveProjectSlug("/home/dev/Projects/ira-memory/")).toBe("ira-memory");
});

// --- Projects root catch-all — deliberate, not a bug (plan D2) ---
test("Projects root, absolute", () => {
  expect(deriveProjectSlug("/home/dev/Projects")).toBe("Projects");
});
test("Projects root, trailing slash", () => {
  expect(deriveProjectSlug("/home/dev/Projects/")).toBe("Projects");
});
test("Projects root, tilde", () => {
  expect(deriveProjectSlug("~/Projects")).toBe("Projects");
});
test("Projects root works for ANY home dir — no hardcode", () => {
  expect(deriveProjectSlug("/home/otheruser/Projects")).toBe("Projects");
});
test("server layout root, lowercase", () => {
  expect(deriveProjectSlug("/srv/projects")).toBe("Projects");
});

// --- server layout, lowercase segment ---
test("lowercase nested segment (server layout)", () => {
  expect(deriveProjectSlug("/srv/projects/widget-api/src")).toBe("widget-api");
});

// --- outside-Projects fallback (Phase 1, plan D2/D6) ---
test("outside Projects falls back to basename, not null", () => {
  expect(deriveProjectSlug("/home/dev/.pi/agent/extensions/memory")).toBe("memory");
});
test("bare home dir falls back to its basename", () => {
  expect(deriveProjectSlug("/home/dev")).toBe("dev");
});
test("false-positive guard: 'MyProjects' is not 'Projects'", () => {
  expect(deriveProjectSlug("/home/dev/MyProjects")).toBe("MyProjects");
});

// --- null/empty only ---
test("null cwd returns null", () => {
  expect(deriveProjectSlug(null)).toBe(null);
});
test("undefined cwd returns null", () => {
  expect(deriveProjectSlug(undefined)).toBe(null);
});
test("empty string returns null", () => {
  expect(deriveProjectSlug("")).toBe(null);
});

// --- parity fixtures shared with the pi extension's slug.test.ts ---
const PARITY_FIXTURES: Array<[cwd: string, slug: string | null]> = [
  ["/home/dev/Projects/ira-memory/src/db", "ira-memory"],
  ["/home/dev/Projects/ira-memory", "ira-memory"],
  ["/home/dev/Projects", "Projects"],
  ["~/Projects/", "Projects"],
  ["/srv/projects/widget-api", "widget-api"],
  ["/home/dev/.pi/agent/extensions/memory", "memory"],
  ["/home/dev/MyProjects", "MyProjects"],
  ["", null],
];
for (const [cwd, want] of PARITY_FIXTURES) {
  test(`parity fixture: ${JSON.stringify(cwd)}`, () => {
    expect(deriveProjectSlug(cwd)).toBe(want);
  });
}
