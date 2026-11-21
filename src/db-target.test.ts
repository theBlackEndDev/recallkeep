import { describe, test, expect } from "bun:test";
import { dumpPlan, parseDatabaseUrl, pgEnv, resolveDbTarget, restorePlan } from "./db-target.js";

const COMPOSE = "/repo/docker-compose.yml";
const URL_COMPOSE = "postgresql://recallkeep:pw@localhost:5433/recallkeep";

describe("parseDatabaseUrl", () => {
  test("splits a normal URL", () => {
    expect(parseDatabaseUrl("postgresql://alice:s3cret@db.example.com:6543/memory")).toEqual({
      host: "db.example.com",
      port: "6543",
      user: "alice",
      password: "s3cret",
      database: "memory",
    });
  });

  test("decodes a password with special characters", () => {
    expect(parseDatabaseUrl("postgresql://u:p%40ss%2Fw%3Ard@localhost/db").password).toBe("p@ss/w:rd");
  });

  test("defaults the port to 5432 and accepts the postgres:// scheme", () => {
    expect(parseDatabaseUrl("postgres://u:p@localhost/db").port).toBe("5432");
  });

  test("drops Prisma-only query parameters but keeps sslmode", () => {
    const c = parseDatabaseUrl("postgresql://u:p@h:5432/db?schema=public&connection_limit=5&sslmode=require");
    expect(c.sslmode).toBe("require");
    expect(pgEnv(c)).toEqual({ PGHOST: "h", PGPORT: "5432", PGUSER: "u", PGDATABASE: "db", PGPASSWORD: "p", PGSSLMODE: "require" });
  });

  test("strips the brackets from an IPv6 host", () => {
    expect(parseDatabaseUrl("postgresql://u:p@[::1]:5433/db").host).toBe("::1");
  });

  test("rejects missing, malformed and non-postgres URLs with a readable message", () => {
    expect(() => parseDatabaseUrl(undefined)).toThrow(/not set/);
    expect(() => parseDatabaseUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => parseDatabaseUrl("mysql://u:p@h/db")).toThrow(/postgresql:\/\//);
    expect(() => parseDatabaseUrl("postgresql://u:p@h:5432/")).toThrow(/no database name/);
  });
});

describe("resolveDbTarget", () => {
  test("the compose port on this machine means the compose service", () => {
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: URL_COMPOSE })).toBe("docker");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/db" })).toBe("docker");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: "postgresql://u:p@[::1]:5433/db" })).toBe("docker");
  });

  test("a different port, or another machine, means your own Postgres", () => {
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: "postgresql://u:p@localhost:5432/db" })).toBe("external");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: "postgresql://u:p@db.internal:5433/db" })).toBe("external");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: "postgresql://u:p@ep-1.neon.tech/db?sslmode=require" })).toBe("external");
  });

  test("RECALLKEEP_DB_PORT moves the compose port", () => {
    const url = "postgresql://u:p@localhost:6000/db";
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: url })).toBe("external");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: url, RECALLKEEP_DB_PORT: "6000" })).toBe("docker");
  });

  test("RECALLKEEP_USE_DOCKER overrides the URL", () => {
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: URL_COMPOSE, RECALLKEEP_USE_DOCKER: "0" })).toBe("external");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: URL_COMPOSE, RECALLKEEP_USE_DOCKER: "false" })).toBe("external");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: "postgresql://u:p@h:5432/db", RECALLKEEP_USE_DOCKER: "1" })).toBe("docker");
  });

  test("no usable URL falls back to the default (compose) setup", () => {
    expect(resolveDbTarget({})).toBe("docker");
    expect(resolveDbTarget({ RECALLKEEP_DATABASE_URL: "garbage" })).toBe("docker");
  });
});

describe("dumpPlan / restorePlan", () => {
  test("compose database: runs inside the compose service, user and database come from the URL", () => {
    const env = { RECALLKEEP_DATABASE_URL: "postgresql://keeper:pw@localhost:5433/mem" };
    expect(dumpPlan(env, COMPOSE)).toMatchObject({
      cmd: "docker",
      args: ["compose", "-f", COMPOSE, "exec", "-T", "db", "pg_dump", "-U", "keeper", "-d", "mem"],
      env: {},
    });
    expect(restorePlan(env, COMPOSE).args).toEqual(["compose", "-f", COMPOSE, "exec", "-T", "db", "psql", "-U", "keeper", "-d", "mem"]);
  });

  test("RECALLKEEP_DB_CONTAINER targets that container (restore uses -i)", () => {
    const env = { RECALLKEEP_DATABASE_URL: URL_COMPOSE, RECALLKEEP_DB_CONTAINER: "my-pg" };
    expect(dumpPlan(env, COMPOSE).args.slice(0, 3)).toEqual(["exec", "my-pg", "pg_dump"]);
    expect(restorePlan(env, COMPOSE).args.slice(0, 3)).toEqual(["exec", "-i", "my-pg"]);
  });

  test("your own Postgres: runs pg_dump on this machine, password in the environment and not in the arguments", () => {
    const env = { RECALLKEEP_DATABASE_URL: "postgresql://alice:s3cret@localhost:5432/memory" };
    const plan = dumpPlan(env, COMPOSE);
    expect(plan.cmd).toBe("pg_dump");
    expect(plan.args).toEqual(["--no-owner", "--no-acl"]);
    expect(plan.env).toMatchObject({ PGHOST: "localhost", PGPORT: "5432", PGUSER: "alice", PGDATABASE: "memory", PGPASSWORD: "s3cret" });
    expect(JSON.stringify(plan.args)).not.toContain("s3cret");
    expect(restorePlan(env, COMPOSE)).toMatchObject({ cmd: "psql", args: ["-q"] });
  });

  test("RECALLKEEP_PG_DUMP and RECALLKEEP_PSQL set the binaries, and the missing-tool hint names the fix", () => {
    const env = {
      RECALLKEEP_DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      RECALLKEEP_PG_DUMP: "/opt/pg/bin/pg_dump",
      RECALLKEEP_PSQL: "/opt/pg/bin/psql",
    };
    expect(dumpPlan(env, COMPOSE).cmd).toBe("/opt/pg/bin/pg_dump");
    expect(restorePlan(env, COMPOSE).cmd).toBe("/opt/pg/bin/psql");
    expect(dumpPlan({ RECALLKEEP_DATABASE_URL: env.RECALLKEEP_DATABASE_URL }, COMPOSE).missingHint).toMatch(/postgresql-client/);
  });

  test("forcing Docker off on the compose port uses local tools", () => {
    const plan = dumpPlan({ RECALLKEEP_DATABASE_URL: URL_COMPOSE, RECALLKEEP_USE_DOCKER: "0" }, COMPOSE);
    expect(plan.cmd).toBe("pg_dump");
    expect(plan.env.PGPORT).toBe("5433");
  });
});
