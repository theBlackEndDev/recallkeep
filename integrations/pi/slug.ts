/**
 * Project tag derivation.
 *
 * A session's memory is tagged by the project folder it started in, so recall
 * for one project never surfaces another's history. This mirrors
 * ira-memory's own `deriveProjectSlug` (`../../src/slug.ts`) byte-for-byte —
 * `slug.test.ts` includes a parity fixture list that both sides must agree on.
 *
 * Three rules, in order:
 *  1. cwd is exactly a "Projects" root (any host/user — no hardcoded home
 *     directory) → the literal catch-all tag `project:Projects`. This is
 *     deliberate, not a bug: general sessions that aren't inside any specific
 *     project still deserve one shared, searchable bucket.
 *  2. cwd contains a `/Projects/<name>` (or `/projects/<name>`) segment →
 *     `project:<name>`, collapsing nested depth to the project root
 *     (`~/Projects/x/src/y` and `~/Projects/x` both give `project:x`).
 *  3. Neither of the above (e.g. `~/.pi/agent/extensions/memory`) →
 *     `project:<basename(cwd)>`. Previously this case returned null and the
 *     session was never captured at all — closing that blind spot is the
 *     point of this rule.
 */

/** Slug only, no `project:` prefix. Shared logic with ira-memory's deriveProjectSlug. */
export function projectSlugForCwd(cwd: string): string | null {
	if (!cwd) return null;
	const trimmed = cwd.replace(/\/+$/, "");
	if (!trimmed) return null;
	if (/(^|\/)[Pp]rojects$/.test(trimmed)) return "Projects";
	const segmentMatch = cwd.match(/\/[Pp]rojects\/([^/]+)(?:\/|$)/);
	if (segmentMatch) return segmentMatch[1];
	const base = trimmed.split("/").pop();
	return base || null;
}

/**
 * Resolve the `project:<slug>` tag for a session's cwd. Only returns null
 * when cwd itself is empty — every non-empty cwd now resolves to something.
 */
export function projectTagForCwd(cwd: string): string | null {
	const slug = projectSlugForCwd(cwd);
	return slug ? `project:${slug}` : null;
}
