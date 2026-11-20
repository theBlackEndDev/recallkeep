// Project slug from a working directory. Kept dependency-free so hooks and the
// MCP server can import it without loading Prisma or the LLM client.

/**
 * Derive a project slug from a session's cwd. This is the one shared
 * algorithm — the pi extension's `slug.ts` (projectSlugForCwd) must implement
 * the same three rules in the same order; a parity test in both repos checks
 * they agree (plan: pi-ira-memory-capture.md D2).
 *
 * Recognized (immediate child of a projects dir, returned verbatim):
 *   /srv/projects/<slug>/...   (server layout)
 *   ~/Projects/<slug>/...               (home layout, e.g. macOS)
 * Nested repos (~/Projects/parent/child) resolve to <parent> — coarser but stable,
 * which is enough to keep distinct projects' memory from bleeding together.
 *
 * cwd is exactly a projects root ("~/Projects", "/srv/projects", with
 * or without a trailing slash) → "Projects", the deliberate catch-all for
 * general sessions that aren't inside any specific project (locked decision,
 * not a bug — see plan §3.4). No home directory is hardcoded: this matches on
 * the path's last segment being literally "projects", so it works for any
 * user or host layout.
 *
 * Anything else (no "projects" segment at all, e.g. `~/.pi/agent/extensions/x`)
 * falls back to `basename(cwd)` rather than null. Before this fallback existed,
 * every session outside a Projects folder was silently uncaptured — this is
 * the fix for that blind spot, not just a pi-specific tweak.
 */
export function deriveProjectSlug(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return null;
  if (/(^|\/)[Pp]rojects$/.test(trimmed)) return "Projects";
  const segmentMatch = cwd.match(/\/[Pp]rojects\/([^/]+)(?:\/|$)/);
  if (segmentMatch) return segmentMatch[1];
  const base = trimmed.split("/").pop();
  return base || null;
}
