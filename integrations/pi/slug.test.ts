import { projectSlugForCwd, projectTagForCwd } from "./slug.ts";

let pass = 0, fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// --- nested paths collapse to the project root ---

check(
  "nested path under a project collapses to the project root",
  projectTagForCwd("/workspace/dev/Projects/recallkeep/src/db"),
  "project:recallkeep",
);
check(
  "project root itself (no trailing slash)",
  projectTagForCwd("/workspace/dev/Projects/recallkeep"),
  "project:recallkeep",
);
check(
  "project root with trailing slash",
  projectTagForCwd("/workspace/dev/Projects/recallkeep/"),
  "project:recallkeep",
);

// --- the Projects root itself, with and without trailing slash ---
// Deliberate catch-all: NOT a bug, and NOT retagged. Every one of
// these must keep resolving to "project:Projects" forever, or existing
// facts become unfindable by their own tag.

check("Projects root, absolute, no trailing slash", projectTagForCwd("/workspace/dev/Projects"), "project:Projects");
check("Projects root, absolute, trailing slash", projectTagForCwd("/workspace/dev/Projects/"), "project:Projects");
check("Projects root, tilde, no trailing slash", projectTagForCwd("~/Projects"), "project:Projects");
check("Projects root, tilde, trailing slash", projectTagForCwd("~/Projects/"), "project:Projects");
check(
  "Projects root works for ANY home dir — no hardcoded home directory",
  projectTagForCwd("/home/otheruser/Projects"),
  "project:Projects",
);
check(
  "lowercase server layout root",
  projectTagForCwd("/srv/projects"),
  "project:Projects",
);

// --- server layout, lowercase "projects" segment ---

check(
  "lowercase nested segment (server layout)",
  projectTagForCwd("/srv/projects/widget-api/src"),
  "project:widget-api",
);

// --- outside-Projects fallback ---
// These used to return null and the session was never
// captured. That silent blind spot is the thing this fallback closes.

check(
  "path outside any Projects dir falls back to basename, not null",
  projectTagForCwd("/workspace/dev/.pi/agent/extensions/memory"),
  "project:memory",
);
check(
  "bare home directory falls back to its basename",
  projectTagForCwd("/workspace/dev"),
  "project:dev",
);
check(
  "false-positive guard: 'MyProjects' is not 'Projects'",
  projectTagForCwd("/workspace/dev/MyProjects"),
  "project:MyProjects",
);

// --- empty input only ---

check("empty string returns null", projectTagForCwd(""), null);
check("projectSlugForCwd empty string returns null", projectSlugForCwd(""), null);

// --- parity contract with recallkeep's deriveProjectSlug ---
// recallkeep (src/slug.ts) implements the identical three-rule algorithm
// server-side, for Claude Code + HTTP X-Cwd resolution. There is no shared
// import between the two, so this fixture list is the parity contract:
// if you change the algorithm here, change deriveProjectSlug in src/slug.ts
// to match, and re-run both test files. (slugFromTag strips the "project:"
// prefix this side adds that the server side does not.)
const PARITY_FIXTURES: Array<[cwd: string, slug: string | null]> = [
  ["/workspace/dev/Projects/recallkeep/src/db", "recallkeep"],
  ["/workspace/dev/Projects/recallkeep", "recallkeep"],
  ["/workspace/dev/Projects", "Projects"],
  ["~/Projects/", "Projects"],
  ["/srv/projects/widget-api", "widget-api"],
  ["/workspace/dev/.pi/agent/extensions/memory", "memory"],
  ["/workspace/dev/MyProjects", "MyProjects"],
  ["", null],
];
for (const [cwd, want] of PARITY_FIXTURES) {
  check(`parity fixture: ${JSON.stringify(cwd)}`, projectSlugForCwd(cwd), want);
}

console.log(`\n${pass} passed, ${fail} failed`);
// Only exit on failure: exiting 0 here would kill the shared bun process before
// any sibling test file in the same `bun test` run had a chance to load.
if (fail) process.exit(1);
