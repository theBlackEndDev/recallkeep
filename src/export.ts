import { spawnSync } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./client.js";
import { dumpPlan, restorePlan, type CommandPlan, type Env } from "./db-target.js";
import type { MemoryFact } from "./types.js";

// ─── Sensitive content detection ────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/,                    // OpenAI keys
  /\b(ghp_[a-zA-Z0-9]{36})\b/,                       // GitHub tokens
  /\b(gho_[a-zA-Z0-9]{36})\b/,                       // GitHub OAuth
  /\b(xoxb-[a-zA-Z0-9-]+)\b/,                        // Slack tokens
  /\b(AKIA[A-Z0-9]{16})\b/,                          // AWS access keys
  /\bpassword\s*\w*\s*[:=]\s*["']?[^\s"']+/i,         // Passwords (password is: X, password=X)
  /\bsecret\s*\w*\s*[:=]\s*["']?[^\s"']+/i,           // Secrets
  /\btoken\s*[:=]\s*["']?[^\s"']{20,}/i,             // Long tokens
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,                    // Base64 long strings
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,     // Credit card numbers
  /\b\d{3}-\d{2}-\d{4}\b/,                           // SSN
];

/**
 * Check if content contains sensitive information.
 */
export function isSensitiveContent(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Auto-detect and mark sensitive facts.
 * Returns count of newly marked facts.
 */
export async function detectSensitiveFacts(): Promise<number> {
  const unmarked = await prisma.memoryFact.findMany({
    where: { isSensitive: false, isArchived: false },
  });

  let count = 0;
  for (const fact of unmarked) {
    if (isSensitiveContent(fact.content)) {
      await prisma.memoryFact.update({
        where: { id: fact.id },
        data: { isSensitive: true },
      });
      count++;
    }
  }

  return count;
}

// ─── Export functions ───────────────────────────────────────────

export interface MemoryExport {
  exportedAt: string;
  stats: {
    sessions: number;
    messages: number;
    facts: number;
    summaries: number;
  };
  sessions: Array<Record<string, unknown>>;
  facts: Array<Record<string, unknown>>;
  summaries: Array<Record<string, unknown>>;
}

/**
 * Export all memory as JSON (for backup/transfer).
 */
export async function exportAll(): Promise<MemoryExport> {
  const [sessions, messages, facts, summaries] = await Promise.all([
    prisma.session.findMany({
      include: { messages: true },
      orderBy: { startedAt: "desc" },
    }),
    prisma.message.count(),
    prisma.memoryFact.findMany({
      where: { isArchived: false, supersededBy: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.summary.findMany({ orderBy: { periodStart: "desc" } }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    stats: {
      sessions: sessions.length,
      messages,
      facts: facts.length,
      summaries: summaries.length,
    },
    sessions: sessions as unknown as Array<Record<string, unknown>>,
    facts: facts as unknown as Array<Record<string, unknown>>,
    summaries: summaries as unknown as Array<Record<string, unknown>>,
  };
}

/**
 * Export as human-readable markdown (MEMORY.md format).
 * Sensitive facts are excluded.
 * Archived and superseded facts are excluded.
 */
export async function exportMarkdown(): Promise<string> {
  const facts = await prisma.memoryFact.findMany({
    where: {
      isArchived: false,
      supersededBy: null,
      isSensitive: false, // Exclude sensitive
    },
    orderBy: { createdAt: "desc" },
  });

  const summaries = await prisma.summary.findMany({
    where: { scope: { in: ["DAILY", "WEEKLY"] } },
    orderBy: { periodStart: "desc" },
    take: 14, // Last 2 weeks
  });

  // Group facts by category
  const byCategory = new Map<string, MemoryFact[]>();
  for (const fact of facts) {
    const existing = byCategory.get(fact.category) ?? [];
    existing.push(fact);
    byCategory.set(fact.category, existing);
  }

  const lines: string[] = [
    "# RecallKeep Export",
    `_Exported: ${new Date().toISOString()}_`,
    `_Active facts: ${facts.length}_`,
    "",
  ];

  // Categories in display order
  const categoryOrder = [
    "PREFERENCE", "CONTEXT", "DECISION", "PLAN", "TODO",
    "PROJECT_STATE", "FACT", "LESSON", "TOOL_CONFIG", "CHECKPOINT",
  ];

  for (const cat of categoryOrder) {
    const catFacts = byCategory.get(cat);
    if (!catFacts || catFacts.length === 0) continue;

    lines.push(`## ${formatCategoryName(cat)}`);
    lines.push("");

    for (const fact of catFacts) {
      const tierBadge = fact.tier === "LONG_TERM" ? "" : ` [${fact.tier}]`;
      lines.push(`- ${fact.content}${tierBadge}`);
    }
    lines.push("");
  }

  if (summaries.length > 0) {
    lines.push("## Recent Summaries");
    lines.push("");
    for (const s of summaries) {
      const date = s.periodStart.toISOString().split("T")[0];
      lines.push(`### ${s.scope} - ${date}`);
      lines.push(s.content);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatCategoryName(cat: string): string {
  return cat
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

// ─── Backup / Restore ───────────────────────────────────────────

// Resolve backups/ relative to this source file so there's no machine-
// specific path baked in. Override with RECALLKEEP_BACKUP_DIR if needed.
const BACKUP_DIR =
  process.env.RECALLKEEP_BACKUP_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "backups");

// How to reach pg_dump/psql is decided in db-target.ts. In short: against this repo's
// docker-compose database they run inside the container (RECALLKEEP_DB_CONTAINER names a
// different container). Against a Postgres you run yourself they run on this machine, so
// the PostgreSQL client tools must be installed (RECALLKEEP_PG_DUMP and RECALLKEEP_PSQL
// set their full paths when they are not on PATH).
const COMPOSE_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "docker-compose.yml");

/** Run a planned command with one end tied to a file. Returns stderr text on failure, null on success. */
function runPlanned(plan: CommandPlan, io: { stdin?: number; stdout?: number }): string | null {
  const r = spawnSync(plan.cmd, plan.args, {
    env: { ...process.env, ...plan.env },
    stdio: [io.stdin ?? "ignore", io.stdout ?? "pipe", "pipe"],
  });
  if (r.error) {
    const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
    return missing ? plan.missingHint : String(r.error.message);
  }
  if (r.status !== 0) return (r.stderr?.toString() || `exited with status ${r.status}`).trim().split("\n").slice(-5).join("\n");
  return null;
}

/**
 * Create a pg_dump backup of the recallkeep database.
 */
export async function backup(env: Env = process.env): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `recallkeep-${timestamp}.sql`;
  const filepath = join(BACKUP_DIR, filename);

  const fd = openSync(filepath, "w");
  let failure: string | null;
  try {
    failure = runPlanned(dumpPlan(env, COMPOSE_FILE), { stdout: fd });
  } finally {
    closeSync(fd);
  }
  if (failure) {
    rmSync(filepath, { force: true }); // never leave a half-written backup that looks real
    throw new Error(`backup failed: ${failure}`);
  }
  return filepath;
}

/**
 * Restore from a pg_dump file.
 */
export async function restore(filepath: string, env: Env = process.env): Promise<void> {
  const fd = openSync(filepath, "r");
  let failure: string | null;
  try {
    failure = runPlanned(restorePlan(env, COMPOSE_FILE), { stdin: fd });
  } finally {
    closeSync(fd);
  }
  if (failure) throw new Error(`restore failed: ${failure}`);
}
