#!/usr/bin/env bun
// Contract smoke test: starts an isolated server (temp HOME, test database,
// provider "none") and records the status code and JSON shape of every HTTP
// endpoint plus the exit code of each CLI command. Compare two runs with diff
// to catch regressions.
//
//   SMOKE_DATABASE_URL=postgresql://.../ira_memory_test bun scripts/smoke.ts > before.txt
//
// The database must already be migrated (bunx prisma migrate deploy). It is
// written to, so never point it at a database you care about.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dbUrl = process.env.SMOKE_DATABASE_URL;
if (!dbUrl) {
  console.error("SMOKE_DATABASE_URL is required (a throwaway, migrated database)");
  process.exit(2);
}
if (/\/ira_memory(\?|$)/.test(dbUrl)) {
  console.error("refusing to run against the main ira_memory database");
  process.exit(2);
}

const root = resolve(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "ira-smoke-"));
const port = Number(process.env.SMOKE_PORT ?? 7799);
const base = `http://127.0.0.1:${port}`;
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  MEMORY_DATABASE_URL: dbUrl,
  MEMORY_API_PORT: String(port),
  MEMORY_API_HOST: "127.0.0.1",
  IRA_LLM_PROVIDER: "none",
  IRA_AUTO_LEARN: "false",
};
const token = process.env.SMOKE_API_TOKEN;
if (token) env.IRA_API_TOKEN = token;

function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, shape((v as any)[k])]),
    );
  }
  return v === null ? "null" : typeof v;
}

const out: string[] = [];
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  out.push(`${method} ${path} -> ${res.status} ${JSON.stringify(shape(parsed))}`);
  return parsed as any;
}

const server = Bun.spawn(["bun", "run", "src/http-server.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await Bun.sleep(200);
  }

  const slug = `smoke-${Date.now()}`;
  await call("GET", "/health");
  await call("POST", "/conversation/log", { role: "user", content: `smoke hello ${slug}`, channel: "smoke" });
  await call("POST", "/conversation/log", {});
  await call("GET", "/conversation/recent?limit=2&channel=smoke");
  await call("GET", `/conversation/search?q=${slug}`);
  await call("GET", "/conversation/search");
  await call("GET", `/conversation/recall?q=${slug}`);
  const recent = await call("GET", "/conversation/recent?limit=1&channel=smoke");
  const msgId = recent?.messages?.[0]?.id ?? "missing";
  await call("GET", `/conversation/message/${msgId}`);
  await call("GET", "/conversation/message/does-not-exist");

  const fact = await call("POST", "/memory", { content: `smoke fact ${slug}`, type: "project", project: slug, tags: ["smoke"] });
  await call("POST", "/memory", {});
  await call("GET", `/memory/list?project=${slug}`);
  await call("GET", `/memory/recall?topic=${slug}&project=${slug}`);
  await call("GET", `/memory/recall?topic=${slug}`, undefined, { "X-Cwd": `/home/alice/Projects/${slug}/src` });
  await call("GET", `/memory/search?q=${slug}&project=${slug}`);
  await call("GET", "/memory/search");
  await call("DELETE", `/memory/${fact?.id ?? "missing"}`);
  await call("DELETE", "/memory/list");

  await call("POST", "/entity", { name: `smoke-${slug}`, type: "test", details: { a: 1 } });
  await call("POST", "/entity", {});
  await call("GET", `/entity/search?q=smoke-${slug}`);
  await call("PUT", `/kv/smoke-${slug}`, { value: { ok: true } });
  await call("GET", `/kv/smoke-${slug}`);
  await call("DELETE", `/kv/smoke-${slug}`);
  await call("GET", `/kv/smoke-${slug}`);

  // pi session sync: an allowed file (under the pi sessions dir) and a refused one.
  const sessDir = join(home, ".pi", "agent", "sessions", "--smoke--");
  mkdirSync(sessDir, { recursive: true });
  const sessFile = join(sessDir, "s.jsonl");
  writeFileSync(
    sessFile,
    [
      { type: "session", version: 3, id: `pi-${slug}`, timestamp: new Date().toISOString(), cwd: `/home/alice/Projects/${slug}` },
      { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "smoke pi", timestamp: Date.now() } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  await call("POST", "/session/sync", { sessionFile: sessFile, cwd: `/home/alice/Projects/${slug}` });
  await call("POST", "/session/sync", { sessionFile: "/etc/passwd" });
  await call("POST", "/session/sync", {});
  await call("GET", "/nope");

  const cli = async (...args: string[]) => {
    const p = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const code = await p.exited;
    out.push(`cli ${args.join(" ")} -> exit ${code}`);
  };
  await cli("list", "--limit", "1");
  await cli("search", slug);
  await cli("recall", "--query", slug);
  await cli("stats");
  await cli("sessions", "--limit", "1");
  await cli("conflicts", "--limit", "1");
  await cli("threads", "--limit", "1");
  await cli("export", "--format", "json");
  await cli("detect-sensitive");
  await cli("maintain");
  await cli("store", "--category", "FACT", "--content", `cli smoke ${slug}`);
} finally {
  server.kill();
  await server.exited;
  rmSync(home, { recursive: true, force: true });
}

console.log(out.join("\n"));
