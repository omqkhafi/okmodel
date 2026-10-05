import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { chooseTopologyPorts, publishTopologyPorts } from "../packages/harness/src/docker-cli.js";
import { decideDocker } from "../packages/harness/src/docker-gate.js";
import { withPglite, withPgliteSchema } from "../packages/harness/src/pglite.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  POSTGRES_VERSIONS,
  assertPostgresVersion,
  postgresVersionFromEnv,
} from "../packages/harness/src/version.js";

test("postgres versions 15 through 18 are accepted", () => {
  expect([...POSTGRES_VERSIONS]).toEqual(["15", "16", "17", "18"]);
  for (const version of POSTGRES_VERSIONS) {
    expect(assertPostgresVersion(version)).toBe(version);
  }
  expect(postgresVersionFromEnv({})).toBe("17");
  expect(() => assertPostgresVersion("14")).toThrow(/outside 15/);
  expect(() => assertPostgresVersion("19")).toThrow(/outside 15/);
});

test("topology keeps 55432 when those ports are free", async () => {
  const ports = await chooseTopologyPorts(
    {},
    async () => true,
    async () => {
      throw new Error("a free default port should not be replaced");
    },
  );
  expect(ports).toEqual({ primary: "55432", replicaA: "55433", replicaB: "55434" });
});

test("topology moves off a host port that is already taken", async () => {
  let next = 56000;
  const ports = await chooseTopologyPorts(
    {},
    async () => false,
    async () => ({ port: next++, close: async () => {} }),
  );
  expect(ports).toEqual({ primary: "56000", replicaA: "56001", replicaB: "56002" });
});

test("an explicit host port is kept", async () => {
  const ports = await chooseTopologyPorts(
    { OKM_PRIMARY_PORT: "56010" },
    async () => false,
    async () => {
      throw new Error("an explicit port should not be replaced");
    },
  );
  expect(ports).toEqual({ primary: "56010", replicaA: "55433", replicaB: "55434" });
});

test("topology ports are recorded for the next CI step", () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-ports-"));
  const file = join(dir, "env");
  publishTopologyPorts(
    { primary: "56000", replicaA: "56001", replicaB: "56002" },
    { GITHUB_ENV: file },
  );
  expect(readFileSync(file, "utf8")).toBe(
    "OKM_PRIMARY_PORT=56000\nOKM_REPLICA_A_PORT=56001\nOKM_REPLICA_B_PORT=56002\n",
  );
  publishTopologyPorts({ primary: "1", replicaA: "2", replicaB: "3" }, {});
});

test("docker tests fail only when Docker is required", () => {
  expect(decideDocker({ daemon: false, reachable: false, required: false })).toEqual({
    run: false,
    fail: false,
    message: "Skipping Postgres tests: Docker is not running.",
  });
  const requiredDown = decideDocker({ daemon: false, reachable: false, required: true });
  if (requiredDown.run) throw new Error("expected a failure");
  expect(requiredDown.fail).toBe(true);
  const daemonOnly = decideDocker({ daemon: true, reachable: false, required: false });
  if (daemonOnly.run) throw new Error("expected a skip");
  expect(daemonOnly.message).toContain("bun run db:up");
  const requiredDaemon = decideDocker({ daemon: true, reachable: false, required: true });
  if (requiredDaemon.run) throw new Error("expected a failure");
  expect(requiredDaemon.fail).toBe(true);
  expect(decideDocker({ daemon: false, reachable: true, required: true })).toEqual({ run: true });
});

const decision = await loadPostgresGate();

postgresTest(decision, "an isolated database accepts a connection and then drops", async () => {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    const rows = await sql<{ n: number }[]>`select 1 as n`;
    expect(rows[0]?.n).toBe(1);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
});

test("pglite databases are isolated", async () => {
  await withPglite(async (left) => {
    await left.exec("create table item (id int)");
    await left.exec("insert into item values (1)");
    await withPglite(async (right) => {
      const found = await right.query<{ name: string | null }>(
        "select to_regclass('public.item') as name",
      );
      expect(found.rows[0]?.name).toBeNull();
    });
  });
});

test("pglite schemas are isolated", async () => {
  await withPgliteSchema(async (db, schema) => {
    await db.exec("create table item (id int)");
    await db.exec("insert into item values (1)");
    const placed = await db.query<{ nsp: string }>(
      "select table_schema as nsp from information_schema.tables where table_name = 'item'",
    );
    expect(placed.rows[0]?.nsp).toBe(schema);
    const missing = await db.query<{ name: string | null }>(
      "select to_regclass('public.item') as name",
    );
    expect(missing.rows[0]?.name).toBeNull();
  });
});
