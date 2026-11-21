/**
 * Where the database lives, and how to reach its command-line tools.
 *
 * RecallKeep only needs a Postgres it can reach through RECALLKEEP_DATABASE_URL
 * (Postgres 16 or newer, with the `vector` and `pg_trgm` extensions). Docker is one
 * way to run that database, not a requirement. Everything that behaves differently
 * with and without Docker (scripts/start.sh, `backup`, `restore`) asks this module.
 *
 * Pure functions, no I/O, so the rules can be tested.
 */

export type Env = Record<string, string | undefined>;

export interface PgConn {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslmode?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Split a postgres:// URL into parts. Throws a readable error when it is not a usable URL. */
export function parseDatabaseUrl(url: string | undefined): PgConn {
  if (!url) throw new Error("RECALLKEEP_DATABASE_URL is not set");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("RECALLKEEP_DATABASE_URL is not a valid URL (expected postgresql://user:password@host:5432/database)");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new Error(`RECALLKEEP_DATABASE_URL must start with postgresql:// (got ${u.protocol}//)`);
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!database) throw new Error("RECALLKEEP_DATABASE_URL has no database name");
  return {
    host: u.hostname.replace(/^\[|\]$/g, "") || "localhost",
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    // Prisma's own query parameters (schema, connection_limit, ...) are not libpq's, so only sslmode is passed on.
    ...(u.searchParams.get("sslmode") ? { sslmode: u.searchParams.get("sslmode")! } : {}),
  };
}

/** libpq environment variables for pg_dump and psql. Keeps the password out of the process list. */
export function pgEnv(c: PgConn): Record<string, string> {
  return {
    PGHOST: c.host,
    PGPORT: c.port,
    PGUSER: c.user,
    PGDATABASE: c.database,
    ...(c.password ? { PGPASSWORD: c.password } : {}),
    ...(c.sslmode ? { PGSSLMODE: c.sslmode } : {}),
  };
}

export type DbTarget = "docker" | "external";

function flag(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

/**
 * Is the database this repo's own docker-compose service, or a Postgres you run yourself?
 *
 * 1. RECALLKEEP_USE_DOCKER=1 or 0 decides it.
 * 2. Otherwise it is the compose service when the URL points at this machine on the port
 *    docker-compose.yml publishes (RECALLKEEP_DB_PORT, default 5433), and external for anything else.
 *    A native Postgres on 5432, a remote server or a managed database are all external.
 */
export function resolveDbTarget(env: Env): DbTarget {
  const forced = flag(env.RECALLKEEP_USE_DOCKER);
  if (forced !== undefined) return forced ? "docker" : "external";
  try {
    const c = parseDatabaseUrl(env.RECALLKEEP_DATABASE_URL);
    const composePort = env.RECALLKEEP_DB_PORT || "5433";
    return LOOPBACK.has(c.host) && c.port === composePort ? "docker" : "external";
  } catch {
    return "docker"; // no usable URL: the default setup is the compose service
  }
}

export interface CommandPlan {
  cmd: string;
  args: string[];
  /** Extra environment for the child process. */
  env: Record<string, string>;
  /** What to tell the user if the command cannot be started. */
  missingHint: string;
}

const DOCKER_HINT = "Docker is not available. Start Docker, or use your own Postgres (see README, 'Without Docker').";

function dockerPrefix(env: Env, composeFile: string, interactive: boolean): string[] {
  const container = env.RECALLKEEP_DB_CONTAINER;
  if (container) return ["docker", "exec", ...(interactive ? ["-i"] : []), container];
  return ["docker", "compose", "-f", composeFile, "exec", "-T", "db"];
}

/** How to run pg_dump. The caller sends the command's stdout to the backup file. */
export function dumpPlan(env: Env, composeFile: string): CommandPlan {
  if (resolveDbTarget(env) === "docker") {
    let user = "recallkeep";
    let db = "recallkeep";
    try {
      const c = parseDatabaseUrl(env.RECALLKEEP_DATABASE_URL);
      user = c.user || user;
      db = c.database;
    } catch {}
    const [cmd, ...rest] = [...dockerPrefix(env, composeFile, false), "pg_dump", "-U", user, "-d", db];
    return { cmd, args: rest, env: {}, missingHint: DOCKER_HINT };
  }
  const bin = env.RECALLKEEP_PG_DUMP || "pg_dump";
  return {
    cmd: bin,
    // No owners or grants, so the dump restores into a database with a different user.
    args: ["--no-owner", "--no-acl"],
    env: pgEnv(parseDatabaseUrl(env.RECALLKEEP_DATABASE_URL)),
    missingHint: `${bin} was not found. Install the PostgreSQL client tools (macOS: brew install libpq; Debian/Ubuntu: apt install postgresql-client) and make sure its folder is on PATH, or set RECALLKEEP_PG_DUMP to the full path.`,
  };
}

/** How to run psql. The caller sends the backup file to the command's stdin. */
export function restorePlan(env: Env, composeFile: string): CommandPlan {
  if (resolveDbTarget(env) === "docker") {
    let user = "recallkeep";
    let db = "recallkeep";
    try {
      const c = parseDatabaseUrl(env.RECALLKEEP_DATABASE_URL);
      user = c.user || user;
      db = c.database;
    } catch {}
    const [cmd, ...rest] = [...dockerPrefix(env, composeFile, true), "psql", "-U", user, "-d", db];
    return { cmd, args: rest, env: {}, missingHint: DOCKER_HINT };
  }
  const bin = env.RECALLKEEP_PSQL || "psql";
  return {
    cmd: bin,
    args: ["-q"],
    env: pgEnv(parseDatabaseUrl(env.RECALLKEEP_DATABASE_URL)),
    missingHint: `${bin} was not found. Install the PostgreSQL client tools (macOS: brew install libpq; Debian/Ubuntu: apt install postgresql-client) and make sure its folder is on PATH, or set RECALLKEEP_PSQL to the full path.`,
  };
}
