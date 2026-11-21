#!/usr/bin/env bun
// Helper for scripts/start.sh.
//
//   bun scripts/db.ts target       prints "docker" or "external" (see src/db-target.ts)
//   bun scripts/db.ts wait [secs]  waits until the database port accepts connections (default 60s)
//
// Bun loads .env from the current folder, so RECALLKEEP_DATABASE_URL set there is seen here.

import { connect } from "node:net";
import { parseDatabaseUrl, resolveDbTarget } from "../src/db-target.ts";

const [cmd, arg] = process.argv.slice(2);

if (cmd === "target") {
  console.log(resolveDbTarget(process.env));
} else if (cmd === "wait") {
  const seconds = Number(arg ?? 60);
  let host: string;
  let port: number;
  try {
    const c = parseDatabaseUrl(process.env.RECALLKEEP_DATABASE_URL);
    host = c.host;
    port = Number(c.port);
  } catch (e) {
    console.error(`[db] ${(e as Error).message}`);
    process.exit(1);
  }
  const open = () =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port, timeout: 2000 });
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("timeout", () => (s.destroy(), resolve(false)));
      s.once("error", () => resolve(false));
    });
  const deadline = Date.now() + seconds * 1000;
  let warned = false;
  while (Date.now() < deadline) {
    if (await open()) process.exit(0);
    if (!warned) {
      console.error(`[db] waiting for Postgres at ${host}:${port} ...`);
      warned = true;
    }
    await Bun.sleep(1000);
  }
  console.error(`[db] Postgres did not accept connections at ${host}:${port} within ${seconds}s. Is it running?`);
  process.exit(1);
} else {
  console.error("usage: bun scripts/db.ts <target|wait [seconds]>");
  process.exit(2);
}
