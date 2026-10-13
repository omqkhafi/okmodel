/**
 * A server error whose text contains CONNECT is the database error.
 *
 * `grant CONNECT on table` and a check named "no_CONNECT_zz" must reject,
 * leave no lock, and leave the connection usable. A real
 * `pg_terminate_backend` stays a lost connection. Each case times out so a
 * hang fails the test.
 */

import { expect } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open as openBun } from "../src/adapters/pg/bunsql.js";
import { open as openPg } from "../src/adapters/pg/nodepostgres.js";
import { open as openPostgres } from "../src/adapters/pg/postgresjs.js";
import { isConnectionLost } from "../src/contracts/connection.js";
import type { DriverPool } from "../src/contracts/driver.js";
import { OkmError } from "../src/contracts/error.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import {
  createIsolatedDatabase,
  openPostgres as openAdmin,
} from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { CHECK_SCHEMA_PREFIX } from "../src/tooling/migrate/check.js";
import { connect as connectBun } from "../src/runtime/pg/bun.js";
import { connect as connectPg } from "../src/runtime/pg/pg.js";
import { connect as connectPostgres } from "../src/runtime/pg/postgresjs.js";

const gate = await loadPostgresGate();
const root = repoRoot();
const notes = table("notes", { id: t.integer().primaryKey(), title: t.text() });
const app = schema({ tables: [notes] });
const DDL = `create table notes (
  id integer primary key,
  title text not null,
  constraint "no_CONNECT_zz" check (id > 0)
)`;

type Driver = "postgresjs" | "pg" | "bun";
type Db = {
  batch(ops: readonly unknown[]): Promise<readonly unknown[]>;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  notes: {
    insert(row: { id: number; title: string }): Promise<unknown>;
    find(options?: { limit?: number }): Promise<readonly unknown[]>;
  };
  close(): Promise<void>;
};
type Tx = {
  notes: Db["notes"];
};

const connectors: Record<Driver, (url: string) => Db> = {
  postgresjs: (url) => connectPostgres(url, { schema: app, max: 1 }) as unknown as Db,
  pg: (url) => connectPg(url, { schema: app, max: 1 }) as unknown as Db,
  bun: (url) => connectBun(url, { schema: app, max: 1 }) as unknown as Db,
};

const pools: Record<Driver, (url: string) => DriverPool> = {
  postgresjs: (url) => openPostgres({ url, max: 1 }),
  pg: (url) => openPg({ url, max: 1 }),
  bun: (url) => openBun({ url, max: 1 }),
};

for (const driver of ["postgresjs", "pg", "bun"] as const) {
  postgresTest(
    gate,
    `${driver}: CONNECT in a server error is not a lost connection`,
    async () => {
      if (driver === "bun" && (typeof Bun === "undefined" || typeof Bun.SQL !== "function")) return;
      const database = await createIsolatedDatabase();
      const admin = openAdmin(database.url);
      const db = connectors[driver](database.url);
      try {
        await admin.unsafe(DDL);
        await expectCheck(db.batch([db.notes.insert({ id: 0, title: "no" })]));
        await expectUnlocked(database.url);
        await db.notes.find({ limit: 1 });

        await expectCheck(
          db.tx(async (tx) => {
            await tx.notes.insert({ id: 0, title: "no" });
          }),
        );
        await expectUnlocked(database.url);
        await db.notes.find({ limit: 1 });

        await expectGrant(pools[driver](database.url));
        await expectUnlocked(database.url);
        await db.notes.find({ limit: 1 });

        await expectTerminated(database.url, pools[driver]);
        await db.notes.find({ limit: 1 });
      } finally {
        await db.close();
        await admin.unsafe("rollback").catch(() => undefined);
        await admin.end({ timeout: 5 });
        await database.close();
      }
    },
    20_000,
  );
}

const CHECK_BODY = `alter table items add constraint "no_CONNECT_zz" check (id > 0);
insert into items (id) values (0);
`;
const CHECK_APPLY = `-- okm-allow OKM1531: constraint name contains CONNECT
-- okm-allow OKM1535: constraint name contains CONNECT
-- okm-allow OKM1542: constraint name contains CONNECT
${CHECK_BODY}`;
const CHECK_REPLAY = `-- okm-allow OKM1542: constraint name contains CONNECT
${CHECK_BODY}`;
const GRANT_SQL = "grant CONNECT on table items to public;\n";

postgresTest(
  gate,
  "migrate apply rejects a check named no_CONNECT_zz",
  async () => {
    await expectApply(CHECK_APPLY, "no_CONNECT_zz");
  },
  20_000,
);

postgresTest(
  gate,
  "migrate check rejects a check named no_CONNECT_zz",
  async () => {
    await expectMigrate(CHECK_REPLAY, "no_CONNECT_zz");
  },
  20_000,
);

postgresTest(
  gate,
  "migrate apply rejects grant CONNECT on a table",
  async () => {
    await expectApply(GRANT_SQL, "CONNECT");
  },
  20_000,
);

postgresTest(
  gate,
  "migrate check rejects grant CONNECT on a table",
  async () => {
    await expectMigrate(GRANT_SQL, "CONNECT");
  },
  20_000,
);

async function expectCheck(pending: Promise<unknown>): Promise<void> {
  const error = await reject(pending);
  expect(isConnectionLost(error)).toBe(false);
  expect(error).toBeInstanceOf(OkmError);
  if (error instanceof OkmError) {
    expect(error.kind).toBe("check");
    expect(error.constraint).toBe("no_CONNECT_zz");
  }
}

async function expectGrant(pool: DriverPool): Promise<void> {
  if (pool.reserve === undefined) throw new Error("the driver cannot reserve a connection");
  const conn = await pool.reserve();
  try {
    await conn.execute("begin");
    const error = await reject(conn.execute("grant CONNECT on table public.notes to public"));
    expect(isConnectionLost(error)).toBe(false);
    if (!(error instanceof Error) || !error.message.includes("CONNECT")) {
      throw new Error(shape(error));
    }
  } finally {
    await conn.release();
    await pool.close();
  }
}

async function expectTerminated(url: string, open: (url: string) => DriverPool): Promise<void> {
  const pool = open(url);
  const admin = openAdmin(url);
  try {
    const pending = pool.execute("select pg_sleep(30)").then(
      () => Promise.reject(new Error("pg_sleep resolved")),
      (caught: unknown) => caught,
    );
    let pid: string | undefined;
    for (let attempt = 0; attempt < 40 && pid === undefined; attempt += 1) {
      const rows = await admin.unsafe<{ pid: string }[]>(
        "select pid::text as pid from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and query like '%pg_sleep%'",
      );
      pid = rows[0]?.pid;
      if (pid === undefined) await Bun.sleep(50);
    }
    if (pid === undefined) throw new Error("pg_sleep did not start");
    await admin.unsafe(`select pg_terminate_backend(${pid})`);
    const error = await Promise.race([
      pending,
      Bun.sleep(5_000).then(() => Promise.reject(new Error("terminate did not reject"))),
    ]);
    if (!isConnectionLost(error)) throw new Error(shape(error));
  } finally {
    await pool.close();
    await admin.end({ timeout: 5 });
  }
}

async function expectUnlocked(url: string): Promise<void> {
  const sql = openAdmin(url);
  const held = await sql.reserve();
  try {
    await held.unsafe("set lock_timeout = '1s'");
    await held.unsafe("begin");
    await held.unsafe("lock table public.notes in access exclusive mode");
    await held.unsafe("commit");
  } finally {
    held.release();
    await sql.end({ timeout: 5 });
  }
}

async function expectApply(extra: string, marker: string): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-connect-text-"));
  try {
    writeProject(cwd, database.url);
    const init = spawn(cwd, ["generate", "init"]);
    if (init.exitCode !== 0) throw new Error(init.stderr?.toString() ?? "generate failed");
    const first = spawn(cwd, ["migrate", "apply"]);
    if (first.exitCode !== 0) throw new Error(first.stderr?.toString() ?? "first apply failed");
    const catalog = readdirSync(join(cwd, "migrations")).find((item) =>
      item.endsWith(".catalog.json"),
    );
    if (catalog === undefined) throw new Error("generate wrote no catalog");
    writeFileSync(join(cwd, "migrations", "0002_connect.sql"), `-- name: connect\n\n${extra}`);
    writeFileSync(
      join(cwd, "migrations", "0002_connect.catalog.json"),
      readFileSync(join(cwd, "migrations", catalog)),
    );
    expectFailed(spawn(cwd, ["migrate", "apply"]), marker);
    await expectQuiet(database.url);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

async function expectMigrate(extra: string, marker: string): Promise<void> {
  const database = await createIsolatedDatabase();
  const cwd = mkdtempSync(join(tmpdir(), "okm-connect-text-"));
  try {
    writeProject(cwd, database.url);
    const init = spawn(cwd, ["generate", "init"]);
    if (init.exitCode !== 0) throw new Error(init.stderr?.toString() ?? "generate failed");
    appendFileSync(migrationSql(cwd), `\n${extra}`);
    expectFailed(spawn(cwd, ["migrate", "check"]), marker);
    expect(await scratchSchemas(database.url)).toEqual([]);
    await expectQuiet(database.url);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await database.close();
  }
}

function expectFailed(proc: ReturnType<typeof Bun.spawnSync>, marker: string): void {
  const err = proc.stderr?.toString() ?? "";
  if (proc.signalCode !== null && proc.signalCode !== undefined) {
    throw new Error(`hung ${String(proc.signalCode)}\n${err}`);
  }
  if (proc.exitCode === 0) throw new Error(`exit 0\n${proc.stdout?.toString() ?? ""}\n${err}`);
  expect(err).not.toContain("error unavailable");
  expect(err).toContain(marker);
}

async function expectQuiet(url: string): Promise<void> {
  const sql = openAdmin(url);
  try {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n
      from pg_stat_activity
      where application_name = 'okmodel' and datname = current_database()
    `;
    expect(rows[0]?.n).toBe("0");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function reject(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected the statement to fail");
}

function shape(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  return ["message", "code", "errno", "sqlstate", "kind"]
    .map((key) => `${key}=${String(Reflect.get(error, key))}`)
    .join(" ");
}

function spawn(cwd: string, argv: readonly string[]): ReturnType<typeof Bun.spawnSync> {
  const script = [
    `import { formatFailure, run } from ${JSON.stringify(join(root, "src/tooling/migrate/commands.ts"))};`,
    `try { await run(${JSON.stringify(argv)}, { cwd: ${JSON.stringify(cwd)}, stdout: (text) => process.stdout.write(text) }); }`,
    "catch (error) { process.stderr.write(formatFailure(error)); process.exitCode = 1; }",
  ].join("\n");
  return Bun.spawnSync(["bun", "-e", script], { cwd, timeout: 8_000 });
}

function writeProject(cwd: string, url: string): void {
  const source = (path: string): string => JSON.stringify(join(root, path));
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      'export const app = schema({ tables: [table("items", { id: t.integer().primaryKey() })] });',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  migrations: "./migrations",',
      `  database: ${JSON.stringify(url)},`,
      "});",
      "",
    ].join("\n"),
  );
}

function migrationSql(cwd: string): string {
  const name = readdirSync(join(cwd, "migrations")).find((item) => item.endsWith(".sql"));
  if (name === undefined) throw new Error("generate wrote no migration");
  return join(cwd, "migrations", name);
}

async function scratchSchemas(url: string): Promise<readonly string[]> {
  const sql = openAdmin(url);
  try {
    const rows = await sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
    `;
    return rows.map((row) => row.nspname);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
